import type { Block } from "./block-buffer";
import type { BufferedAudioNode } from "./node";
import { createProgressGate, type ProgressGate } from "./progress-gate";
import { BufferedStream, type StreamSetupContext } from "./stream";
import type { TransformNodeProperties } from "./transform";
import { toReadable } from "./utils/to-readable";

export abstract class UnbufferedTransformStream<N extends BufferedAudioNode<TransformNodeProperties> = BufferedAudioNode<TransformNodeProperties>> extends BufferedStream<N> {
	private framesBuffered = 0;
	private framesEmitted = 0;
	private hasStarted = false;
	private sourceTotalFrames?: number;

	async setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.durationFrames;
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
		const bufferGate = createProgressGate(this.sourceTotalFrames);
		const emitGate = createProgressGate(this.sourceTotalFrames);

		try {
			for await (const block of input) {
				if (!this.hasStarted) {
					this.hasStarted = true;
					this.emitStarted();
				}

				this.framesBuffered += block.samples[0]?.length ?? 0;
				if (bufferGate(this.framesBuffered, Date.now())) this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);

				yield* this.emitted(this.timed(this._transform(block)), emitGate);
			}

			yield* this.emitted(this.timed(this._flush()), emitGate);

			this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
			this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
			this.emitFinished({ framesDone: this.framesBuffered, processingMs: this.processingMs });
		} finally {
			await this.destroy();
		}
	}

	private async *emitted(blocks: AsyncIterable<Block>, emitGate: ProgressGate): AsyncGenerator<Block> {
		for await (const block of blocks) {
			yield block;

			this.framesEmitted += block.samples[0]?.length ?? 0;
			if (emitGate(this.framesEmitted, Date.now())) this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
		}
	}

	abstract _transform(block: Block): AsyncIterable<Block> | Iterable<Block>;

	_flush(): AsyncIterable<Block> | Iterable<Block> {
		return [];
	}
}
