import { BufferedAudioNode, wireStream, type Block, type BufferedAudioNodeProperties, type ExecutionProvider, type RenderOptions, type StreamContext } from "./node";
import { BufferedStream } from "./stream";
import { TargetNode } from "./target";
import { TransformNode } from "./transform";
import { teeReadable } from "./utils/tee-readable";

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

export abstract class BufferedSourceStream<P extends SourceNodeProperties = SourceNodeProperties> extends BufferedStream<P> {
	private framesRead = 0;
	private hasStarted = false;

	abstract getMetadata(): Promise<SourceMetadata>;

	abstract _read(): Promise<Block | undefined>;
	abstract _flush(): Promise<void>;

	setup(context: StreamContext): Promise<ReadableStream<Block>> {
		return this._setup(context);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async _setup(context: StreamContext): Promise<ReadableStream<Block>> {
		let done = false;

		this.framesRead = 0;
		this.hasStarted = false;

		const { signal, durationFrames: sourceTotalFrames, highWaterMark } = context;

		return new ReadableStream<Block>(
			{
				pull: async (controller) => {
					if (done) return;
					if (signal?.aborted) {
						done = true;
						controller.close();

						return;
					}

					try {
						if (!this.hasStarted) {
							this.hasStarted = true;
							this.events.emit("started");
						}

						const chunk = await this._read();

						if (!chunk) {
							done = true;
							this.emitProgress("read", this.framesRead, sourceTotalFrames, { force: true });
							await this._flush();
							this.events.emit("finished", { framesDone: this.framesRead });
							controller.close();

							return;
						}

						this.framesRead += chunk.samples[0]?.length ?? 0;
						controller.enqueue(chunk);
						this.emitProgress("read", this.framesRead, sourceTotalFrames);
					} catch (error) {
						done = true;
						controller.error(error);
					}
				},
				cancel: () => {
					done = true;
				},
			},
			{ highWaterMark },
		);
	}
}

export abstract class SourceNode<P extends SourceNodeProperties = SourceNodeProperties> extends BufferedAudioNode<P> {
	static override is(value: unknown): value is SourceNode {
		return BufferedAudioNode.is(value) && value.type[1] === "source";
	}

	to(child: BufferedAudioNode): void {
		this.properties = { ...this.properties, children: [...(this.properties.children ?? []), child] } as P;
	}

	private renderTimingData?: RenderTiming;

	get renderTiming(): RenderTiming | undefined {
		return this.renderTimingData;
	}

	protected abstract createStream(): BufferedSourceStream<P>;

	async getMetadata(): Promise<SourceMetadata> {
		const stream = this.createStream();

		return stream.getMetadata();
	}

	async setup(context: StreamContext): Promise<void> {
		const stream = this.createStream();

		this.streams.push(stream);

		wireStream(this, stream, context);

		const readable = await stream.setup(context);
		const promises = await this.setupChildren(readable, context);

		await Promise.all(promises);
	}

	private async setupChildren(readable: ReadableStream<Block>, context: StreamContext): Promise<Array<Promise<void>>> {
		const resolved = this.children;
		const pairs = teeReadable(readable, resolved);

		const nested = await Promise.all(
			pairs.map(async ([stream, child]) => {
				if (context.visited.has(child)) throw new Error("Cycle detected in node graph");

				context.visited.add(child);

				if (TargetNode.is(child) || TransformNode.is(child)) return child.setup(stream, context);

				throw new Error(`Unknown child node type`);
			}),
		);

		return nested.flat();
	}

	async render(options?: RenderOptions): Promise<void> {
		const defaultProviders: ReadonlyArray<ExecutionProvider> = ["gpu", "cpu-native", "cpu"];
		const memoryLimit = options?.memoryLimit ?? 256 * 1024 * 1024;

		const meta = await this.getMetadata();

		const stages = Math.max(1, countNodes(this));
		const chunkSize = options?.chunkSize ?? 128 * 1024;
		const bytesPerChunk = meta.channels * chunkSize * 4;
		const computedHighWaterMark = Math.max(1, Math.floor(memoryLimit / (stages * bytesPerChunk)));

		const context: StreamContext = {
			executionProviders: options?.executionProviders ?? defaultProviders,
			memoryLimit,
			durationFrames: meta.durationFrames,
			highWaterMark: options?.highWaterMark ?? computedHighWaterMark,
			signal: options?.signal,
			visited: new Set<BufferedAudioNode>(),
			onEvent: options?.onEvent,
			progressQuantum: options?.progressQuantum,
		};

		const start = performance.now();

		try {
			await this.setup(context);
		} finally {
			const totalMs = performance.now() - start;
			const audioDurationMs = meta.durationFrames !== undefined ? (meta.durationFrames / meta.sampleRate) * 1000 : 0;

			this.renderTimingData = {
				totalMs,
				audioDurationMs,
				realTimeMultiplier: audioDurationMs > 0 ? audioDurationMs / totalMs : 0,
			};
			await this.teardown();
		}
	}
}

function countNodes(node: BufferedAudioNode): number {
	let count = 0;

	for (const child of node.children) {
		count += 1 + countNodes(child);
	}

	return count;
}
