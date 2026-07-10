import { BlockBuffer } from "./block-buffer";
import type { Block, BufferedAudioNode, StreamContext } from "./node";
import { createProgressGate, type ProgressGate } from "./progress-gate";
import { BufferedStream, type StreamRenderContext } from "./stream";
import type { TransformNodeProperties } from "./transform";
import { toReadable } from "./utils/to-readable";

export const WHOLE_FILE = Infinity;

export interface BufferedTransformNodeProperties extends TransformNodeProperties {
	readonly blockSize?: number;
	readonly streamChunkSize?: number;
}

function slice(block: Block, offset: number, frames: number): Block {
	if (offset === 0 && frames === (block.samples[0]?.length ?? 0)) return block;

	return {
		samples: block.samples.map((channel) => channel.subarray(offset, offset + frames)),
		offset: block.offset + offset,
		sampleRate: block.sampleRate,
		bitDepth: block.bitDepth,
	};
}

export abstract class BufferedTransformStream<N extends BufferedAudioNode<BufferedTransformNodeProperties> = BufferedAudioNode<BufferedTransformNodeProperties>> extends BufferedStream<N> {
	blockSize: number;

	private framesBuffered = 0;
	private framesEmitted = 0;

	private buffer?: BlockBuffer;
	private inferredChunkSize?: number;
	private hasStarted = false;
	private sourceTotalFrames?: number;

	constructor(node: BufferedAudioNode, context: StreamRenderContext) {
		super(node, context);

		const blockSize = this.properties.blockSize ?? WHOLE_FILE;

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

	protected get streamChunkSize(): number | undefined {
		return this.properties.streamChunkSize;
	}

	async setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.durationFrames;
		await this._setup(context);

		return this._pipe(input);
	}

	_setup(_context: StreamContext): Promise<void> | void {
		return;
	}

	_pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		return toReadable(this.blocks(input));
	}

	private async *blocks(input: ReadableStream<Block>): AsyncGenerator<Block> {
		const buffer = (this.buffer ??= new BlockBuffer());
		const bufferGate = createProgressGate(this.sourceTotalFrames);
		const emitGate = createProgressGate(this.sourceTotalFrames);

		try {
			for await (const block of input) {
				if (!this.hasStarted) {
					this.hasStarted = true;
					this.emitStarted();
				}

				this.inferredChunkSize ??= block.samples[0]?.length ?? 0;

				const blockFrames = block.samples[0]?.length ?? 0;

				for (let offset = 0; offset < blockFrames; ) {
					const frames = this.blockSize === WHOLE_FILE ? blockFrames : Math.min(this.blockSize - buffer.frames, blockFrames - offset);
					const start = performance.now();
					const prepared = await this._prepare(slice(block, offset, frames));

					await buffer.write(prepared.samples, prepared.sampleRate, prepared.bitDepth);
					this.processingMs += performance.now() - start;
					offset += frames;
					this.framesBuffered += frames;
					if (bufferGate(this.framesBuffered, Date.now())) this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);

					if (this.blockSize !== WHOLE_FILE && buffer.frames >= this.blockSize) yield* this.batch(buffer, emitGate);
				}
			}

			if (buffer.frames > 0) yield* this.batch(buffer, emitGate);

			yield* this.chunked(this.timed(this._flush()), emitGate);

			this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
			this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
			this.emitFinished({ framesDone: this.framesBuffered, processingMs: this.processingMs });
		} finally {
			await this.destroy();
		}
	}

	private async *batch(buffer: BlockBuffer, emitGate: ProgressGate): AsyncGenerator<Block> {
		await buffer.flushWrites();

		const batchFrames = buffer.frames;

		if (this.blockSize === WHOLE_FILE) this.emitProgress("process", 0, batchFrames);

		yield* this.chunked(this.timed(this._transform(buffer)), emitGate);

		if (this.blockSize === WHOLE_FILE) this.emitProgress("process", batchFrames, batchFrames);

		await buffer.clear();
	}

	private async *chunked(blocks: AsyncIterable<Block>, emitGate: ProgressGate): AsyncGenerator<Block> {
		for await (const block of blocks) {
			const frames = block.samples[0]?.length ?? 0;
			const cap = this.outputChunkSize;

			if (frames > cap) {
				for (let start = 0; start < frames; start += cap) yield slice(block, start, Math.min(cap, frames - start));
			} else {
				yield block;
			}

			this.framesEmitted += frames;
			if (emitGate(this.framesEmitted, Date.now())) this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
		}
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

	_prepare(block: Block): Promise<Block> | Block {
		return block;
	}

	async *_transform(buffered: BlockBuffer): AsyncIterable<Block> {
		yield* buffered.iterate(this.outputChunkSize);
	}

	_flush(): AsyncIterable<Block> | Iterable<Block> {
		return [];
	}
}
