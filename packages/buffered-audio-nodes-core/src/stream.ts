import type { EventEmitter } from "node:events";
import type { BufferedAudioNode, BufferedAudioNodeProperties, NodeIdentity } from "./node";

export type StreamPhase = "read" | "buffer" | "process" | "emit" | "write";

export interface ProgressPayload {
	phase: StreamPhase;
	framesDone: number;
	framesTotal?: number;
}

export interface FinishedPayload {
	framesDone: number;
	processingMs?: number;
}

export interface LogPayload {
	level: "info" | "warn";
	message: string;
	data?: Record<string, unknown>;
}

export type RenderEvents = EventEmitter<{
	started: [NodeIdentity];
	finished: [NodeIdentity, FinishedPayload];
	progress: [NodeIdentity, ProgressPayload];
	log: [NodeIdentity, LogPayload];
}>;

export const UNKNOWN_TOTAL_QUANTUM_FRAMES = 480_000;
export const DEFAULT_PROGRESS_QUANTUM = 0.1;
export const PROCESS_QUANTUM_FRACTION = 0.02;

export abstract class BufferedStream<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> {
	readonly node: BufferedAudioNode;
	readonly properties: P;

	private renderEvents?: RenderEvents;
	private identity?: NodeIdentity;
	private quantumFraction = DEFAULT_PROGRESS_QUANTUM;

	private destroyed = false;

	private readonly lastBoundaryByPhase = new Map<StreamPhase, number>();

	constructor(node: BufferedAudioNode) {
		this.node = node;
		this.properties = { ...node.properties } as P;
	}

	bind(events: RenderEvents, identity: NodeIdentity, quantumFraction: number): void {
		this.renderEvents = events;
		this.identity = identity;
		this.quantumFraction = quantumFraction;
	}

	protected emitStarted(): void {
		if (this.renderEvents && this.identity) this.renderEvents.emit("started", this.identity);
	}

	protected emitFinished(payload: FinishedPayload): void {
		if (this.renderEvents && this.identity) this.renderEvents.emit("finished", this.identity, payload);
	}

	protected emitProgress(phase: StreamPhase, framesDone: number, framesTotal?: number, options?: { force?: boolean }): void {
		if (!this.renderEvents || !this.identity) return;

		const total = framesTotal !== undefined && framesTotal > 0 ? framesTotal : undefined;

		if (options?.force) {
			this.lastBoundaryByPhase.set(phase, framesDone);
			this.renderEvents.emit("progress", this.identity, { phase, framesDone, framesTotal: total });

			return;
		}

		const fraction = phase === "process" ? Math.min(this.quantumFraction, PROCESS_QUANTUM_FRACTION) : this.quantumFraction;
		const quantum = total ? Math.max(1, Math.floor(total * fraction)) : UNKNOWN_TOTAL_QUANTUM_FRAMES;
		const boundary = Math.floor(framesDone / quantum) * quantum;
		const last = this.lastBoundaryByPhase.get(phase);

		if (last !== undefined && boundary <= last) return;

		this.lastBoundaryByPhase.set(phase, boundary);
		this.renderEvents.emit("progress", this.identity, { phase, framesDone, framesTotal: total });
	}

	protected log(message: string, data?: Record<string, unknown>, level: "info" | "warn" = "info"): void {
		if (this.renderEvents && this.identity) this.renderEvents.emit("log", this.identity, { level, message, data });
	}

	protected progress(framesDone: number, framesTotal?: number): void {
		this.emitProgress("process", framesDone, framesTotal);
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
