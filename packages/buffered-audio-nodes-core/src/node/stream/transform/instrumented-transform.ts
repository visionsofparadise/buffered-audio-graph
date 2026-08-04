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

	async setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.sourceTotalFrames;
		this.temporaryDirectory = context.temporaryDirectory;

		await this._setup(context);

		return this._pipe(input);
	}

	_setup(_context: StreamSetupContext): Promise<void> | void {
		return;
	}

	_pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		return toReadable(this.blocks(input));
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
