import type { EventEmitter } from "node:events";
import type { BufferedAudioNode } from "./node";

export type ExecutionProvider = "gpu" | "cpu-native" | "cpu";

export interface StreamIdentity {
	readonly nodeName: string;
	readonly nodeId?: string;
	readonly streamId: number;
}

export interface StreamSetupContext {
	readonly executionProviders: ReadonlyArray<ExecutionProvider>;
	readonly memoryLimit: number;
	readonly durationFrames?: number;
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

export type RenderEvents = EventEmitter<{
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
	private destroyed = false;

	constructor(node: N, context: StreamContext) {
		this.node = node;
		this.events = context.events;

		const constructor = node.constructor as typeof BufferedAudioNode;

		this.identity = { nodeName: constructor.nodeName, nodeId: node.id, streamId: context.nextStreamId() };
	}

	get properties(): N["properties"] {
		return this.node.properties;
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
				const result = await iterator.next();

				this.processingMs += performance.now() - start;

				if (result.done) return;

				yield result.value;
			}
		} finally {
			await iterator.return();
		}
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;

		this.destroyed = true;

		await this._destroy();
	}

	_destroy(): Promise<void> | void {
		return;
	}
}
