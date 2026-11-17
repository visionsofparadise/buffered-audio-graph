import type { BufferedAudioNode } from "..";
import type { EventEmitter } from "node:events";

export type ExecutionProvider = "gpu" | "cpu-native" | "cpu";

export interface StreamIdentity {
	readonly nodeName: string;
	readonly nodeId?: string;
	readonly streamId: number;
}

export interface StreamSetupContext {
	readonly executionProviders: ReadonlyArray<ExecutionProvider>;
	readonly memoryLimit: number;
	readonly temporaryDirectory: string;
	readonly sourceSampleRate: number;
	/**
	 * The rate flowing at this point in the chain; a rate-changing stream assigns its outgoing rate in _setup.
	 */
	sampleRate: number;
	readonly sourceTotalFrames?: number;
	readonly highWaterMark: number;
	readonly signal?: AbortSignal;
}

export type StreamPhase = "read" | "buffer" | "process" | "emit" | "write";

export interface StartedPayload {
	createdAt: number;
}

export interface ProgressPayload {
	phase: StreamPhase;
	framesDone: number;
	framesTotal?: number;
	createdAt: number;
}

export interface FinishedPayload {
	framesDone: number;
	processingMs?: number;
	createdAt: number;
}

export interface LogPayload {
	level: "info" | "warn";
	message: string;
	data?: Record<string, unknown>;
	createdAt: number;
}

export interface RenderLivenessPayload {
	readonly createdAt: number;
	readonly elapsedMs: number;
}

export type RenderEvents = EventEmitter<{
	liveness: [RenderLivenessPayload];
	started: [StreamIdentity, StartedPayload];
	finished: [StreamIdentity, FinishedPayload];
	progress: [StreamIdentity, ProgressPayload];
	log: [StreamIdentity, LogPayload];
}>;

export interface StreamContext {
	readonly events: RenderEvents;
	readonly nextStreamId: () => number;
}

export abstract class BufferedStream<N extends BufferedAudioNode = BufferedAudioNode> {
	readonly identity: StreamIdentity;
	readonly node: N;
	protected readonly events: RenderEvents;
	protected processingMs = 0;

	private readonly cancelController = new AbortController();
	private readonly hookCalls = new Set<Promise<unknown>>();
	private renderSignal?: AbortSignal;
	private combinedSignal?: AbortSignal;
	private teardown?: Promise<void>;

	constructor(node: N, context: StreamContext) {
		this.node = node;
		this.events = context.events;

		const constructor = node.constructor as typeof BufferedAudioNode;

		this.identity = { nodeName: constructor.nodeName, nodeId: node.id, streamId: context.nextStreamId() };
	}

	get properties(): N["properties"] {
		return this.node.properties;
	}

	protected get isDestroyed(): boolean {
		return this.teardown !== undefined;
	}

	protected recordRenderSignal(context: StreamSetupContext): void {
		this.renderSignal = context.signal;
	}

	protected get streamSignal(): AbortSignal {
		if (!this.renderSignal) return this.cancelController.signal;

		return (this.combinedSignal ??= AbortSignal.any([this.cancelController.signal, this.renderSignal]));
	}

	protected abortStream(): void {
		this.cancelController.abort();
	}

	protected stopRequested(): boolean {
		if (this.renderSignal?.aborted) throw this.renderSignal.reason;

		return this.cancelController.signal.aborted;
	}

	protected trackHook<T>(call: Promise<T> | T): Promise<T> {
		const promise = Promise.resolve(call);
		const settle = (): void => {
			this.hookCalls.delete(promise);
		};

		this.hookCalls.add(promise);
		promise.then(settle, settle);

		return promise;
	}

	protected emitStarted(): void {
		this.events.emit("started", this.identity, { createdAt: Date.now() });
	}

	protected emitFinished(payload: Omit<FinishedPayload, "createdAt">): void {
		this.events.emit("finished", this.identity, { ...payload, createdAt: Date.now() });
	}

	protected emitProgress(phase: StreamPhase, framesDone: number, framesTotal?: number): void {
		this.events.emit("progress", this.identity, { phase, framesDone, framesTotal, createdAt: Date.now() });
	}

	protected log(message: string, data?: Record<string, unknown>, level: "info" | "warn" = "info"): void {
		this.events.emit("log", this.identity, { level, message, data, createdAt: Date.now() });
	}

	protected async *timed<T>(source: AsyncIterable<T> | Iterable<T>): AsyncGenerator<T> {
		const iterator = (async function* () {
			yield* source;
		})();

		try {
			for (;;) {
				const start = performance.now();
				const result = await this.trackHook(iterator.next());

				this.processingMs += performance.now() - start;

				if (result.done) return;

				yield result.value;
			}
		} finally {
			await iterator.return();
		}
	}

	destroy(): Promise<void> {
		this.teardown ??= Promise.resolve().then(async () => this.tearDown());

		return this.teardown;
	}

	private async tearDown(): Promise<void> {
		this.cancelController.abort();

		while (this.hookCalls.size > 0) await Promise.allSettled([...this.hookCalls]);

		await this._destroy();
	}

	_destroy(): Promise<void> | void {
		return;
	}
}
