import type { Block, BufferedAudioNode, StreamContext } from "./node";
import { createProgressGate } from "./progress-gate";
import { BufferedStream } from "./stream";
import type { TransformNodeProperties } from "./transform";

export abstract class UnbufferedTransformStream<N extends BufferedAudioNode<TransformNodeProperties> = BufferedAudioNode<TransformNodeProperties>> extends BufferedStream<N> {
	private processingMs = 0;
	private framesBuffered = 0;
	private framesEmitted = 0;
	private hasStarted = false;
	private sourceTotalFrames?: number;

	private bufferGate = createProgressGate();
	private emitGate = createProgressGate();

	setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.durationFrames;
		this.bufferGate = createProgressGate(context.durationFrames);
		this.emitGate = createProgressGate(context.durationFrames);

		return this._setup(input, context);
	}

	// FIX: we should disable this rule if it's blocking writing perfectly valid code
	// eslint-disable-next-line @typescript-eslint/require-await
	async _setup(input: ReadableStream<Block>, _context: StreamContext): Promise<ReadableStream<Block>> {
		return input.pipeThrough(this.createTransformStream()); // FIX: We should have a another step _pipe which is called in setup() instead of doing this here. Downstream overwrites of _setup shouldn't have to know about the stream piping. those that do want to hook into the piping phase should overwrite _pipe()
	}

	// FIX: "TransformStream" is overloaded in our context, we should call this createWebTransformStream to differentiate
	createTransformStream(): TransformStream<Block, Block> {
		// FIX: Shouldn't we create our equeue here and pass it to handleTransform and handleFlush? instead of creating a method for it
		return new TransformStream<Block, Block>({
			transform: (block, controller) => this.handleTransform(block, controller),
			flush: (controller) => this.handleFlush(controller),
			cancel: () => this.destroy(),
		});
	}

	private makeEnqueue(controller: TransformStreamDefaultController<Block>): (block: Block) => void {
		return (block) => {
			controller.enqueue(block);
			this.framesEmitted += block.samples[0]?.length ?? 0;
			if (this.emitGate(this.framesEmitted, Date.now())) this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
		};
	}

	private async handleTransform(block: Block, controller: TransformStreamDefaultController<Block>): Promise<void> {
		if (!this.hasStarted) {
			this.hasStarted = true;
			this.emitStarted();
		}

		const start = performance.now();

		await this.transform(block, this.makeEnqueue(controller));

		this.processingMs += performance.now() - start;
		this.framesBuffered += block.samples[0]?.length ?? 0;

		if (this.bufferGate(this.framesBuffered, Date.now())) this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
	}

	private async handleFlush(controller: TransformStreamDefaultController<Block>): Promise<void> {
		const start = performance.now();

		await this.flush(this.makeEnqueue(controller));

		this.processingMs += performance.now() - start;

		this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
		this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
		this.emitFinished({ framesDone: this.framesBuffered, processingMs: this.processingMs });

		await this.destroy();
	}

	abstract transform(block: Block, enqueue: (block: Block) => void): Promise<void> | void;

	flush(_enqueue: (block: Block) => void): Promise<void> | void {
		return;
	} // FIX: This is a noop?
}
