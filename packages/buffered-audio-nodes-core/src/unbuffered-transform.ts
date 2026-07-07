import type { Block, StreamContext } from "./node";
import { BufferedStream } from "./stream";
import type { TransformNodeProperties } from "./transform";

export abstract class UnbufferedTransformStream<P extends TransformNodeProperties = TransformNodeProperties> extends BufferedStream<P> {
	private processingMs = 0;
	private framesBuffered = 0;
	private framesEmitted = 0;
	private hasStarted = false;
	private sourceTotalFrames?: number;

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
			controller.enqueue(block);
			this.framesEmitted += block.samples[0]?.length ?? 0;
			this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
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

		this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
	}

	private async handleFlush(controller: TransformStreamDefaultController<Block>): Promise<void> {
		const start = performance.now();

		await this.flush(this.makeEnqueue(controller));

		this.processingMs += performance.now() - start;

		this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames, { force: true });
		this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames, { force: true });
		this.emitFinished({ framesDone: this.framesBuffered, processingMs: this.processingMs });

		await this.destroy();
	}

	abstract transform(block: Block, enqueue: (block: Block) => void): Promise<void> | void;

	 
	flush(_enqueue: (block: Block) => void): Promise<void> | void {
		return;
	}
}
