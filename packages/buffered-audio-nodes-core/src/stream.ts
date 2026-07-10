import type { EventEmitter } from "node:events";
import type { BufferedAudioNode, NodeIdentity } from "./node";

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
	started: [NodeIdentity, StartedPayload];
	finished: [NodeIdentity, FinishedPayload];
	progress: [NodeIdentity, ProgressPayload];
	log: [NodeIdentity, LogPayload];
}>;

export interface StreamRenderContext {
	readonly events: RenderEvents;
	readonly startedAt: number;
	readonly nextStreamId: () => number;
}

export abstract class BufferedStream<N extends BufferedAudioNode = BufferedAudioNode> {
	readonly node: N;
	readonly identity: NodeIdentity;

	protected readonly renderEvents: RenderEvents; // FIX: Why the qualifier of render events?
	protected readonly renderStartedAt: number;

	private destroyed = false;

	constructor(node: BufferedAudioNode, context: StreamRenderContext) {
		this.node = node as N;
		this.renderEvents = context.events;
		this.renderStartedAt = context.startedAt;

		const constructor = node.constructor as typeof BufferedAudioNode;

		this.identity = { nodeName: constructor.nodeName, nodeId: node.id, streamId: context.nextStreamId() };
	}

	get properties(): N["properties"] {
		return this.node.properties;
	}

	protected emitStarted(): void {
		this.renderEvents.emit("started", this.identity, { createdAt: Date.now() });
	}

	protected emitFinished(payload: Omit<FinishedPayload, "createdAt">): void {
		this.renderEvents.emit("finished", this.identity, { ...payload, createdAt: Date.now() });
	}

	protected emitProgress(phase: StreamPhase, framesDone: number, framesTotal?: number): void {
		this.renderEvents.emit("progress", this.identity, { phase, framesDone, framesTotal, createdAt: Date.now() });
	}

	protected log(message: string, data?: Record<string, unknown>, level: "info" | "warn" = "info"): void {
		this.renderEvents.emit("log", this.identity, { level, message, data, createdAt: Date.now() });
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
