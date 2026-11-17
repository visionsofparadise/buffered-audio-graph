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

	private readonly cancelController = new AbortController();
	private renderSignal?: AbortSignal;
	private combinedSignal?: AbortSignal;

	async setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.sourceTotalFrames;
		this.temporaryDirectory = context.temporaryDirectory;
		this.renderSignal = context.signal;

		await this._setup(context);

		return this._pipe(input);
	}

	_setup(_context: StreamSetupContext): Promise<void> | void {
		return;
	}

	_pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		return toReadable(this.blocks(input), { onCancel: () => this.cancelController.abort() });
	}

	protected get streamSignal(): AbortSignal {
		if (!this.renderSignal) return this.cancelController.signal;

		return (this.combinedSignal ??= AbortSignal.any([this.cancelController.signal, this.renderSignal]));
	}

	protected stopRequested(): boolean {
		if (this.renderSignal?.aborted) throw this.renderSignal.reason;

		return this.cancelController.signal.aborted;
	}

	protected async *readInput(input: ReadableStream<Block>): AsyncGenerator<Block> {
		const reader = input.getReader();
		const signal = this.streamSignal;
		const cancelOnAbort = (): void => {
			reader.cancel().catch(() => undefined);
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

			if (!ended) await reader.cancel();
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
