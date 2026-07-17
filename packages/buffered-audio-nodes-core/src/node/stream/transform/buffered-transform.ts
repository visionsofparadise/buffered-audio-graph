import { BufferedStream, type StreamContext, type StreamSetupContext } from "..";
import type { BufferedAudioNode } from "../..";
import { sliceBlock } from "../../../utils/slice-block";
import { toReadable } from "../../../utils/to-readable";
import type { TransformNodeProperties } from "../../transform";
import type { Block } from "../block";
import { createProgressGate, type ProgressGate } from "../utils/progress-gate";
import { BlockBuffer } from "./utils/block-buffer";

export const WHOLE_FILE = Infinity;

export interface BufferedTransformNodeProperties extends TransformNodeProperties {
	readonly blockSize?: number;
	readonly streamChunkSize?: number;
}

export abstract class BufferedTransformStream<N extends BufferedAudioNode<BufferedTransformNodeProperties> = BufferedAudioNode<BufferedTransformNodeProperties>> extends BufferedStream<N> {
	blockSize: number;

	private framesBuffered = 0;
	private framesEmitted = 0;

	private buffer?: BlockBuffer;
	private inferredChunkSize?: number;
	private hasStarted = false;
	private sourceTotalFrames?: number;

	constructor(node: N, context: StreamContext) {
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

	async setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.sourceTotalFrames;

		await this._setup(context);

		return this._pipe(input);
	}

	_setup(_context: StreamSetupContext): Promise<void> | void {
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
					const prepared = await this._prepare(sliceBlock(block, offset, frames));

					await buffer.write(prepared.samples, prepared.sampleRate, prepared.bitDepth);

					this.processingMs += performance.now() - start;
					offset += frames;
					this.framesBuffered += frames;

					if (bufferGate(this.framesBuffered, Date.now())) this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);

					if (this.blockSize !== WHOLE_FILE && buffer.frames >= this.blockSize) yield* this.batch(buffer, emitGate);
				}
			}

			if (buffer.frames > 0) yield* this.batch(buffer, emitGate);

			const flushed = this._flush();
			const timed = this.timed(flushed);

			yield* this.chunked(timed, emitGate);

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

		const output = this._transform(buffer);
		const timed = this.timed(output);

		yield* this.chunked(timed, emitGate);

		if (this.blockSize === WHOLE_FILE) this.emitProgress("process", batchFrames, batchFrames);

		await buffer.clear();
	}

	private async *chunked(blocks: AsyncIterable<Block>, emitGate: ProgressGate): AsyncGenerator<Block> {
		for await (const block of blocks) {
			const frames = block.samples[0]?.length ?? 0;
			const cap = this.outputChunkSize;

			if (frames > cap) {
				for (let start = 0; start < frames; start += cap) yield sliceBlock(block, start, Math.min(cap, frames - start));
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
