import { BufferedStream, type StreamSetupContext } from ".";
import { BufferedAudioNode, type BufferedAudioNodeProperties } from "..";
import type { Block } from "./block";
import { createProgressGate } from "./utils/progress-gate";

export interface TargetNodeProperties extends BufferedAudioNodeProperties {}

export abstract class BufferedTargetStream<N extends BufferedAudioNode<TargetNodeProperties> = BufferedAudioNode<TargetNodeProperties>> extends BufferedStream<N> {
	private hasStarted = false;
	private framesWritten = 0;
	private sourceTotalFrames?: number;

	abstract _write(chunk: Block): Promise<void> | void;
	abstract _close(): Promise<void> | void;

	setup(readable: ReadableStream<Block>, context: StreamSetupContext): Promise<void> {
		this.sourceTotalFrames = context.sourceTotalFrames;

		return Promise.resolve(this._setup(readable, context));
	}

	_setup(input: ReadableStream<Block>, _context: StreamSetupContext): Promise<void> | void {
		return input.pipeTo(this.createWritableStream());
	}

	private createWritableStream(): WritableStream<Block> {
		this.hasStarted = false;
		this.framesWritten = 0;
		this.processingMs = 0;

		const writeGate = createProgressGate(this.sourceTotalFrames);

		return new WritableStream<Block>({
			write: async (chunk) => {
				if (!this.hasStarted) {
					this.hasStarted = true;
					this.emitStarted();
				}

				const start = performance.now();

				await this._write(chunk);

				this.processingMs += performance.now() - start;
				this.framesWritten += chunk.samples[0]?.length ?? 0;

				if (writeGate(this.framesWritten, Date.now())) this.emitProgress("write", this.framesWritten, this.sourceTotalFrames);
			},
			close: async () => {
				const start = performance.now();

				await this._close();

				this.processingMs += performance.now() - start;

				this.emitProgress("write", this.framesWritten, this.sourceTotalFrames);
				this.emitFinished({ framesDone: this.framesWritten, processingMs: this.processingMs });
				await this.destroy();
			},
			abort: async () => {
				await this.destroy();
			},
		});
	}
}

export abstract class TargetNode<P extends TargetNodeProperties = TargetNodeProperties> extends BufferedAudioNode<P> {}
