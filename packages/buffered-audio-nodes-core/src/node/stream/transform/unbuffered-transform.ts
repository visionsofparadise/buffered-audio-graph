import { createProgressGate, type ProgressGate } from "../utils/progress-gate";
import { InstrumentedTransformStream } from "./instrumented-transform";
import type { BufferedAudioNode } from "../..";
import type { TransformNodeProperties } from "../../transform";
import type { Block } from "../block";

export abstract class UnbufferedTransformStream<
	N extends BufferedAudioNode<TransformNodeProperties> = BufferedAudioNode<TransformNodeProperties>,
> extends InstrumentedTransformStream<N> {
	protected async *blocks(input: ReadableStream<Block>): AsyncGenerator<Block> {
		const bufferGate = createProgressGate(this.sourceTotalFrames);
		const emitGate = createProgressGate(this.sourceTotalFrames);

		try {
			for await (const block of input) {
				this.markStarted();

				this.framesBuffered += block.samples[0]?.length ?? 0;

				if (bufferGate(this.framesBuffered, Date.now()))
					this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);

				const output = this._transform(block);
				const timed = this.timed(output);

				yield* this.emitted(timed, emitGate);
			}

			const flushed = this._flush();
			const timed = this.timed(flushed);

			yield* this.emitted(timed, emitGate);

			this.emitCompletion();
		} finally {
			await this.destroy();
		}
	}

	private async *emitted(blocks: AsyncIterable<Block>, emitGate: ProgressGate): AsyncGenerator<Block> {
		for await (const block of blocks) {
			yield block;

			this.framesEmitted += block.samples[0]?.length ?? 0;

			if (emitGate(this.framesEmitted, Date.now()))
				this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
		}
	}

	abstract _transform(block: Block): AsyncIterable<Block> | Iterable<Block>;
}
