import { BlockBuffer } from "./block-buffer";
import { BufferedAudioNode, wireStream, type Block, type BufferedAudioNodeProperties, type StreamContext } from "./node";
import { BufferedStream } from "./stream";
import { TargetNode } from "./target";
import { teeReadable } from "./utils/tee-readable";

declare global {
	// Node ≥ 20 Web Streams fire transformer cancel(reason); the bundled DOM lib omits it.
	// Declaration-merge requires the type params to match DOM's Transformer<I = any, O = any> exactly.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
	interface Transformer<I = any, O = any> {
		cancel?: (reason?: unknown) => void | PromiseLike<void>;
	}
}

export const WHOLE_FILE = Infinity;

export interface TransformNodeProperties extends BufferedAudioNodeProperties {
	readonly overlap?: number;
	readonly streamChunkSize?: number;
}

export class BufferedTransformStream<P extends TransformNodeProperties = TransformNodeProperties> extends BufferedStream<P> {
	bufferSize: number;
	readonly overlap: number;

	processingMs = 0;
	framesProcessed = 0;

	private framesBuffered = 0;
	private framesEmitted = 0;

	private chunkBuffer?: BlockBuffer;
	private bufferOffset = 0;
	private inferredChunkSize?: number;
	private hasStarted = false;

	protected streamChunkSize?: number;
	private sourceTotalFrames?: number;

	constructor(properties: P) {
		super(properties);

		this.bufferSize = properties.bufferSize ?? 0;
		this.overlap = properties.overlap ?? 0;
		this.streamChunkSize = properties.streamChunkSize;
	}

	protected get sampleRate(): number | undefined {
		return this.chunkBuffer?.sampleRate;
	}

	protected get bitDepth(): number | undefined {
		return this.chunkBuffer?.bitDepth;
	}

	private get outputChunkSize(): number {
		return this.streamChunkSize ?? this.inferredChunkSize ?? 44100;
	}

	setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.durationFrames;

		return this._setup(input, context);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async _setup(input: ReadableStream<Block>, _context: StreamContext): Promise<ReadableStream<Block>> {
		return input.pipeThrough(this.createTransformStream());
	}

	createTransformStream(): TransformStream<Block, Block> {
		return new TransformStream<Block, Block>({
			transform: (chunk, controller) => this.handleTransform(chunk, controller),
			flush: (controller) => this.handleFlush(controller),
			cancel: () => this.destroy(),
		});
	}

	private async handleTransform(chunk: Block, controller: TransformStreamDefaultController<Block>): Promise<void> {
		if (!this.hasStarted) {
			this.hasStarted = true;

			this.events.emit("started");
		}

		const chunkFrames = chunk.samples[0]?.length ?? 0;

		this.inferredChunkSize ??= chunkFrames;

		this.chunkBuffer ??= new BlockBuffer();

		const samplesIn = chunkFrames;
		const start = performance.now();

		if (this.bufferSize === 0 || this.bufferSize === WHOLE_FILE) {
			await this._buffer(chunk, this.chunkBuffer);

			if (this.bufferSize === 0) {
				await this.emitBuffer(controller);
			} else if (this.bufferSize !== WHOLE_FILE) {
				while (this.chunkBuffer.frames >= this.bufferSize) {
					await this.processAndEmit(controller);
				}
			}

			this.processingMs += performance.now() - start;
			this.framesProcessed += samplesIn;
			this.framesBuffered += samplesIn;

			this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);

			return;
		}

		let offset = 0;

		while (offset < chunkFrames) {
			const space = this.bufferSize - this.chunkBuffer.frames;
			const take = Math.min(space, chunkFrames - offset);

			const sliced: Block = {
				samples: chunk.samples.map((channel) => channel.subarray(offset, offset + take)),
				offset: chunk.offset + offset,
				sampleRate: chunk.sampleRate,
				bitDepth: chunk.bitDepth,
			};

			await this._buffer(sliced, this.chunkBuffer);
			offset += take;

			if (this.chunkBuffer.frames >= this.bufferSize) {
				await this.processAndEmit(controller);
			}
		}

		this.processingMs += performance.now() - start;
		this.framesProcessed += samplesIn;
		this.framesBuffered += samplesIn;

		this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
	}

	private async handleFlush(controller: TransformStreamDefaultController<Block>): Promise<void> {
		await this.finalizeFlush(controller);
		await this.destroy();
	}

	private async finalizeFlush(controller: TransformStreamDefaultController<Block>): Promise<void> {
		this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames, { force: true });

		if (!this.chunkBuffer || this.chunkBuffer.frames === 0) {
			await this.emitFlushChunks(controller);
			this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames, { force: true });
			this.events.emit("finished", { framesDone: this.framesBuffered, processingMs: this.processingMs });

			return;
		}

		if (this.bufferSize === 0) {
			await this.chunkBuffer.close();
			await this.emitFlushChunks(controller);
			this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames, { force: true });
			this.events.emit("finished", { framesDone: this.framesBuffered, processingMs: this.processingMs });

			return;
		}

		try {
			await this.processAndEmit(controller);
		} finally {
			await this.chunkBuffer.close();

			this.chunkBuffer = undefined;
		}

		await this.emitFlushChunks(controller);
		this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames, { force: true });
		this.events.emit("finished", { framesDone: this.framesBuffered, processingMs: this.processingMs });
	}

	private async emitFlushChunks(controller: TransformStreamDefaultController<Block>): Promise<void> {
		const chunks = await this._flush();

		if (!chunks) return;

		for (const chunk of chunks) {
			controller.enqueue(chunk);
			this.framesEmitted += chunk.samples[0]?.length ?? 0;
		}
	}

	private async processAndEmit(controller: TransformStreamDefaultController<Block>): Promise<void> {
		if (!this.chunkBuffer) return;

		const samplesBeforeProcess = this.chunkBuffer.frames;
		const start = performance.now();
		const wholeFile = this.bufferSize === WHOLE_FILE;

		await this.chunkBuffer.flushWrites();

		if (wholeFile) this.emitProgress("process", 0, undefined, { force: true });
		await this._process(this.chunkBuffer);
		if (wholeFile) this.emitProgress("process", samplesBeforeProcess, samplesBeforeProcess, { force: true });

		await this.emitBuffer(controller);

		this.processingMs += performance.now() - start;
		this.framesProcessed += samplesBeforeProcess;
	}

	private async emitBuffer(controller: TransformStreamDefaultController<Block>): Promise<void> {
		if (!this.chunkBuffer) return;

		const buffer = this.chunkBuffer;
		const totalFrames = buffer.frames;
		const emitSize = this.bufferSize === 0 ? totalFrames : this.outputChunkSize;
		const channels = buffer.channels;
		const wantsOverlap = this.overlap > 0 && this.bufferSize !== WHOLE_FILE;
		const overlap = this.overlap;
		const canPreserveOverlap = wantsOverlap && totalFrames > overlap;

		const overlapScratch: Array<Float32Array> | undefined = canPreserveOverlap
			? Array.from({ length: channels }, () => new Float32Array(overlap))
			: undefined;
		let overlapFilled = 0;

		await buffer.reset();

		for (;;) {
			const chunk = await buffer.read(emitSize);
			const chunkFrames = chunk.samples[0]?.length ?? 0;

			if (chunkFrames === 0) break;

			const adjusted: Block = {
				samples: chunk.samples,
				offset: this.bufferOffset + chunk.offset,
				sampleRate: chunk.sampleRate,
				bitDepth: chunk.bitDepth,
			};

			const result = await this._unbuffer(adjusted);

			if (result) controller.enqueue(result);

			this.framesEmitted += chunkFrames;
			this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);

			if (overlapScratch) {
				if (chunkFrames >= overlap) {
					for (let ch = 0; ch < channels; ch++) {
						const dest = overlapScratch[ch];
						const src = chunk.samples[ch];

						if (dest && src) dest.set(src.subarray(chunkFrames - overlap, chunkFrames), 0);
					}

					overlapFilled = overlap;
				} else {
					const shift = Math.max(0, overlapFilled + chunkFrames - overlap);

					for (let ch = 0; ch < channels; ch++) {
						const dest = overlapScratch[ch];

						if (!dest) continue;
						if (shift > 0) dest.copyWithin(0, shift, overlapFilled);
						const src = chunk.samples[ch];

						if (src) dest.set(src.subarray(0, chunkFrames), overlapFilled - shift);
					}

					overlapFilled = overlapFilled - shift + chunkFrames;
				}
			}

			if (chunkFrames < emitSize) break;
		}

		this.bufferOffset += totalFrames;

		if (canPreserveOverlap && overlapScratch) {
			await buffer.clear();
			await buffer.write(overlapScratch, buffer.sampleRate, buffer.bitDepth);
			this.bufferOffset -= overlap;
		} else {
			await buffer.clear();
		}
	}

	override async destroy(): Promise<void> {
		try {
			await super.destroy();
		} finally {
			if (this.chunkBuffer) {
				await this.chunkBuffer.close();
				this.chunkBuffer = undefined;
			}
		}
	}

	_buffer(chunk: Block, buffer: BlockBuffer): Promise<void> | void {
		return buffer.write(chunk.samples, chunk.sampleRate, chunk.bitDepth);
	}

	_process(_buffer: BlockBuffer): Promise<void> | void {
		return;
	}

	_unbuffer(chunk: Block): Promise<Block | undefined> | Block | undefined {
		return chunk;
	}

	_flush(): Promise<Array<Block> | undefined> | Array<Block> | undefined {
		return undefined;
	}
}

export abstract class TransformNode<P extends TransformNodeProperties = TransformNodeProperties> extends BufferedAudioNode<P> {
	static override is(value: unknown): value is TransformNode {
		return BufferedAudioNode.is(value) && value.type[1] === "transform";
	}

	to(child: BufferedAudioNode): void {
		this.properties = { ...this.properties, children: [...(this.properties.children ?? []), child] } as P;
	}

	abstract createStream(): BufferedTransformStream;

	async setup(readable: ReadableStream<Block>, context: StreamContext): Promise<Array<Promise<void>>> {
		const stream = this.createStream();

		this.streams.push(stream);

		wireStream(this, stream, context);

		const output = await stream.setup(readable, context);

		return this.setupChildren(output, context);
	}

	private async setupChildren(readable: ReadableStream<Block>, context: StreamContext): Promise<Array<Promise<void>>> {
		const resolved = this.children;
		const pairs = teeReadable(readable, resolved);

		const nested = await Promise.all(
			pairs.map(async ([stream, child]) => {
				if (context.visited.has(child)) throw new Error("Cycle detected in node graph");

				context.visited.add(child);

				if (TransformNode.is(child) || TargetNode.is(child)) return child.setup(stream, context);

				throw new Error(`Unknown child node type`);
			}),
		);

		return nested.flat();
	}
}
