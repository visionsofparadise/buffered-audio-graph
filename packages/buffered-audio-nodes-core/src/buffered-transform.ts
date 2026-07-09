import { BlockBuffer } from "./block-buffer";
import type { Block, BufferedAudioNode, StreamContext } from "./node";
import { BufferedStream } from "./stream";
import type { TransformNodeProperties } from "./transform";

export const WHOLE_FILE = Infinity;

// FIX: We need to have this narrowed to a type with blockSize
export abstract class BufferedTransformStream<P extends TransformNodeProperties = TransformNodeProperties> extends BufferedStream<P> {
	blockSize: number;

	private processingMs = 0;
	private framesBuffered = 0;
	private framesEmitted = 0;

	private buffer?: BlockBuffer;
	private inferredChunkSize?: number;
	private hasStarted = false;
	private sourceTotalFrames?: number;

	constructor(node: BufferedAudioNode) {
		super(node);

		const blockSize = (this.properties as { blockSize?: number }).blockSize ?? WHOLE_FILE;

		if (blockSize === 0) throw new Error("BufferedTransformStream: blockSize must be a positive integer or WHOLE_FILE, not 0");

		this.blockSize = blockSize;
	}

	protected get sampleRate(): number | undefined {
		return this.buffer?.sampleRate;
	}

	protected get bitDepth(): number | undefined {
		return this.buffer?.bitDepth;
	}

	private get outputChunkSize(): number {
		return this.streamChunkSize ?? this.inferredChunkSize ?? 44100;
	}

	protected get streamChunkSize() {
		return this.properties.streamChunkSize;
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
			transform: (block, controller) => this.handleTransform(block, controller),
			flush: (controller) => this.handleFlush(controller),
			cancel: () => this.destroy(),
		});
	}

	private makeEnqueue(controller: TransformStreamDefaultController<Block>): (block: Block) => void {
		return (block) => {
			const frames = block.samples[0]?.length ?? 0;
			const cap = this.outputChunkSize;

			if (frames > cap) {
				for (let start = 0; start < frames; start += cap) {
					const take = Math.min(cap, frames - start);

					controller.enqueue({
						samples: block.samples.map((channel) => channel.subarray(start, start + take)), // FIX: Can you explain what exactly we're doing here?
						offset: block.offset + start,
						sampleRate: block.sampleRate,
						bitDepth: block.bitDepth,
					});
				}
			} else {
				controller.enqueue(block);
			}

			this.framesEmitted += frames;
			this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
		};
	}

	private async handleTransform(block: Block, controller: TransformStreamDefaultController<Block>): Promise<void> {
		if (!this.hasStarted) {
			this.hasStarted = true;
			this.emitStarted();
		}

		const blockFrames = block.samples[0]?.length ?? 0;

		this.inferredChunkSize ??= blockFrames;
		this.buffer ??= new BlockBuffer();

		const start = performance.now();

		if (this.blockSize === WHOLE_FILE) {
			const prepared = await this.prepare(block);

			await this.buffer.write(prepared.samples, prepared.sampleRate, prepared.bitDepth);
		} else {
			let offset = 0;

			while (offset < blockFrames) {
				const space = this.blockSize - this.buffer.frames;
				const take = Math.min(space, blockFrames - offset);

				const sliced: Block = {
					samples: block.samples.map((channel) => channel.subarray(offset, offset + take)),
					offset: block.offset + offset,
					sampleRate: block.sampleRate,
					bitDepth: block.bitDepth,
				};

				const prepared = await this.prepare(sliced);

				await this.buffer.write(prepared.samples, prepared.sampleRate, prepared.bitDepth);
				offset += take;

				if (this.buffer.frames >= this.blockSize) {
					await this.fireTransform(controller);
				}
			}
		}

		this.processingMs += performance.now() - start;
		this.framesBuffered += blockFrames;

		this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
	}

	private async fireTransform(controller: TransformStreamDefaultController<Block>): Promise<void> {
		// FIX: This is confusing. Why do we have fireTransform and transform? Does unravelling enqueue to being passed in make it so we can consolidate them into one transform method?
		if (!this.buffer) return;

		const framesBefore = this.buffer.frames;
		const start = performance.now();
		const wholeFile = this.blockSize === WHOLE_FILE;

		await this.buffer.flushWrites();

		if (wholeFile) this.emitProgress("process", 0, framesBefore, { force: true });
		await this.transform(this.buffer, this.makeEnqueue(controller));
		if (wholeFile) this.emitProgress("process", framesBefore, framesBefore, { force: true });

		await this.buffer.clear();

		this.processingMs += performance.now() - start;
	}

	private async handleFlush(controller: TransformStreamDefaultController<Block>): Promise<void> {
		await this.finalizeFlush(controller);
		await this.destroy();
	}

	private async finalizeFlush(controller: TransformStreamDefaultController<Block>): Promise<void> {
		this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames, { force: true });

		if (this.buffer && this.buffer.frames > 0) {
			await this.fireTransform(controller);
		}

		await this.flush(this.makeEnqueue(controller));

		this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames, { force: true });
		this.emitFinished({ framesDone: this.framesBuffered, processingMs: this.processingMs });
	}

	override async destroy(): Promise<void> {
		try {
			await super.destroy();
		} finally {
			if (this.buffer) {
				await this.buffer.close();
				this.buffer = undefined;
			}
		}
	}

	prepare(block: Block): Promise<Block> | Block {
		return block;
	}

	async transform(buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
		for await (const block of buffered.iterate(this.outputChunkSize)) {
			enqueue(block);
		}
	}

	flush(_enqueue: (block: Block) => void): Promise<void> | void {
		return;
	}
}
