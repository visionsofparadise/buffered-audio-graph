import type { Block, BufferedAudioNode, StreamContext } from "./node";
import { createProgressGate } from "./progress-gate";
import { BufferedStream } from "./stream";
import type { TransformNodeProperties } from "./transform";

function iteratorOf(iterable: AsyncIterable<Block> | Iterable<Block>): AsyncIterator<Block> | Iterator<Block> {
	if (Symbol.asyncIterator in iterable) return iterable[Symbol.asyncIterator]();

	return iterable[Symbol.iterator]();
}

export abstract class UnbufferedTransformStream<
	N extends BufferedAudioNode<TransformNodeProperties> = BufferedAudioNode<TransformNodeProperties>,
> extends BufferedStream<N> {
	private processingMs = 0;
	private framesBuffered = 0;
	private framesEmitted = 0;
	private hasStarted = false;
	private sourceTotalFrames?: number;

	setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.durationFrames;

		return this.orchestrate(input, context);
	}

	private async orchestrate(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		await this._setup(context);

		return this._pipe(input);
	}

	_setup(_context: StreamContext): Promise<void> | void {
		return;
	}

	_pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		const reader = input.getReader();
		const bufferGate = createProgressGate(this.sourceTotalFrames);
		const emitGate = createProgressGate(this.sourceTotalFrames);

		let iterator: AsyncIterator<Block> | Iterator<Block> | undefined;
		let inputEnded = false;
		let flushDone = false;

		return new ReadableStream<Block>({
			pull: async (controller) => {
				for (;;) {
					if (iterator) {
						const start = performance.now();
						const result = await iterator.next();

						this.processingMs += performance.now() - start;

						if (!result.done) {
							controller.enqueue(result.value);
							this.framesEmitted += result.value.samples[0]?.length ?? 0;
							if (emitGate(this.framesEmitted, Date.now())) this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);

							return;
						}

						iterator = undefined;

						continue;
					}

					if (!inputEnded) {
						const { value, done } = await reader.read();

						if (done) {
							inputEnded = true;

							continue;
						}

						if (!this.hasStarted) {
							this.hasStarted = true;
							this.emitStarted();
						}

						this.framesBuffered += value.samples[0]?.length ?? 0;
						if (bufferGate(this.framesBuffered, Date.now())) this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);

						iterator = iteratorOf(this._transform(value));

						continue;
					}

					if (!flushDone) {
						flushDone = true;
						iterator = iteratorOf(this._flush());

						continue;
					}

					this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
					this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
					this.emitFinished({ framesDone: this.framesBuffered, processingMs: this.processingMs });
					controller.close();
					await this.destroy();

					return;
				}
			},
			cancel: async (reason) => {
				await iterator?.return?.();
				await reader.cancel(reason);
				await this.destroy();
			},
		});
	}

	abstract _transform(block: Block): AsyncIterable<Block> | Iterable<Block>;

	_flush(): AsyncIterable<Block> | Iterable<Block> {
		return [];
	}
}
