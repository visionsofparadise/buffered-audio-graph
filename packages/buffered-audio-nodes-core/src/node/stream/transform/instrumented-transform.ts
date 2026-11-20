import { BufferedStream, type StreamSetupContext } from "..";
import { toReadable } from "../../../utils/to-readable";
import type { BufferedAudioNode } from "../..";
import type { TransformNodeProperties } from "../../transform";
import type { Block } from "../block";

export abstract class InstrumentedTransformStream<
	N extends BufferedAudioNode<TransformNodeProperties> = BufferedAudioNode<TransformNodeProperties>,
> extends BufferedStream<N> {
	protected framesBuffered = 0;
	protected framesEmitted = 0;
	protected hasStarted = false;
	protected sourceTotalFrames?: number;
	protected temporaryDirectory!: string;

	private pipeline?: AsyncGenerator<Block>;
	private pipelineFinishing = false;
	private cancelRequested = false;

	async setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.sourceTotalFrames;
		this.temporaryDirectory = context.temporaryDirectory;
		this.recordRenderSignal(context);

		try {
			this.throwIfStopped();

			await this.trackHook(this._setup(context));
		} catch (error) {
			await input.cancel(error).catch(() => undefined);

			throw error;
		}

		return this._pipe(input);
	}

	_setup(_context: StreamSetupContext): Promise<void> | void {
		return;
	}

	_pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		const pipeline = this.guarded(this.blocks(input));

		this.pipeline = pipeline;

		return toReadable(pipeline, {
			onCancel: () => {
				this.cancelRequested = true;
				this.abortStream();
			},
		});
	}

	protected override async unwind(): Promise<void> {
		if (!this.pipeline || this.pipelineFinishing) return;

		await this.pipeline.return(undefined);
	}

	private async *guarded(blocks: AsyncGenerator<Block>): AsyncGenerator<Block> {
		let failed = false;

		try {
			yield* blocks;
		} catch (error) {
			failed = true;

			throw error;
		} finally {
			await this.finishPipeline(failed);
		}
	}

	private async finishPipeline(failed: boolean): Promise<void> {
		this.pipelineFinishing = true;

		if (this.isDestroyed) return;

		try {
			await this.destroy();
		} catch (error) {
			if (!failed && !this.cancelRequested) throw error;
		}
	}

	protected async *readInput(input: ReadableStream<Block>): AsyncGenerator<Block> {
		const reader = input.getReader();
		const signal = this.streamSignal;
		let cancelling: Promise<void> | undefined;
		const cancelOnAbort = (): void => {
			cancelling = reader.cancel();
			cancelling.catch(() => undefined);
		};
		let ended = false;

		if (signal.aborted) cancelOnAbort();
		else signal.addEventListener("abort", cancelOnAbort, { once: true });

		try {
			for (;;) {
				let result: ReadableStreamReadResult<Block>;

				try {
					result = await reader.read();
				} catch (error) {
					ended = true;

					throw error;
				}

				if (this.stopRequested()) return;

				if (result.done) {
					ended = true;

					return;
				}

				yield result.value;
			}
		} finally {
			signal.removeEventListener("abort", cancelOnAbort);

			if (!ended) await (cancelling ?? reader.cancel());
		}
	}

	protected abstract blocks(input: ReadableStream<Block>): AsyncGenerator<Block>;

	protected markStarted(): void {
		if (this.hasStarted) return;

		this.hasStarted = true;

		this.emitStarted();
	}

	protected emitCompletion(): void {
		this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
		this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
		this.emitFinished({ framesDone: this.framesBuffered, processingMs: this.processingMs });
	}

	_flush(): AsyncIterable<Block> | Iterable<Block> {
		return [];
	}
}
