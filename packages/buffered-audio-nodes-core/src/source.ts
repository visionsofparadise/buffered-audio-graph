import type { Block } from "./block-buffer";
import { BufferedAudioNode, type BufferedAudioNodeProperties, type Composition } from "./node";
import { createProgressGate } from "./progress-gate";
import { RenderJob, type RenderOptions } from "./render-job";
import { BufferedStream, type StreamSetupContext } from "./stream";

export interface SourceMetadata {
	readonly sampleRate: number;
	readonly channels: number;
	readonly durationFrames?: number;
}

export interface RenderTiming {
	readonly totalMs: number;
	readonly audioDurationMs: number;
	readonly realTimeMultiplier: number;
}

export interface SourceNodeProperties extends BufferedAudioNodeProperties {}

export abstract class BufferedSourceStream<N extends BufferedAudioNode<SourceNodeProperties> = BufferedAudioNode<SourceNodeProperties>> extends BufferedStream<N> {
	private framesRead = 0;
	private hasStarted = false;

	abstract getMetadata(): Promise<SourceMetadata>;

	abstract _read(): Promise<Block | undefined>;

	setup(context: StreamSetupContext): Promise<ReadableStream<Block>> {
		return Promise.resolve(this._setup(context));
	}

	_setup(context: StreamSetupContext): Promise<ReadableStream<Block>> | ReadableStream<Block> {
		let done = false;

		this.framesRead = 0;
		this.processingMs = 0;
		this.hasStarted = false;

		const { signal, durationFrames: sourceTotalFrames, highWaterMark } = context;
		const readGate = createProgressGate(sourceTotalFrames);

		return new ReadableStream<Block>(
			{
				pull: async (controller) => {
					if (done) return;
					if (signal?.aborted) {
						done = true;
						await this.destroy();
						controller.close();

						return;
					}

					try {
						if (!this.hasStarted) {
							this.hasStarted = true;
							this.emitStarted();
						}

						const start = performance.now();
						const chunk = await this._read();

						this.processingMs += performance.now() - start;

						if (!chunk) {
							done = true;
							this.emitProgress("read", this.framesRead, sourceTotalFrames);
							this.emitFinished({ framesDone: this.framesRead, processingMs: this.processingMs });
							await this.destroy();
							controller.close();

							return;
						}

						this.framesRead += chunk.samples[0]?.length ?? 0;
						controller.enqueue(chunk);
						if (readGate(this.framesRead, Date.now())) this.emitProgress("read", this.framesRead, sourceTotalFrames);
					} catch (error) {
						done = true;
						await this.destroy();
						controller.error(error);
					}
				},
				cancel: async () => {
					done = true;
					await this.destroy();
				},
			},
			{ highWaterMark },
		);
	}
}

export abstract class SourceNode<P extends SourceNodeProperties = SourceNodeProperties> extends BufferedAudioNode<P> {
	to(child: BufferedAudioNode | Composition): void {
		const head = "head" in child ? child.head : child;

		this.properties = { ...this.properties, children: [...(this.properties.children ?? []), head] } as P;
	}

	createRenderJob(options?: RenderOptions): RenderJob {
		return new RenderJob(this, options);
	}
}
