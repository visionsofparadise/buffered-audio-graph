import type { EventEmitter } from "node:events"; // FIX: I'm getting a type error "Cannot find name 'node:events'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.". is our tsconfig set properly?
import type { BufferedAudioNode, BufferedAudioNodeProperties, NodeIdentity } from "./node";

export type StreamPhase = "read" | "buffer" | "process" | "emit" | "write";

export interface ProgressPayload {
	phase: StreamPhase;
	framesDone: number;
	framesTotal?: number;
	// FIX: We should be tracking createdAt, absolute time for all events emitted.
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
// FIX: We should just commit on quantum size being a fixed constant.

export abstract class BufferedStream<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> {
	// FIX: Why do we take the properties type rather than the Node type? We're having to assert the node type because of this, when properties is accessible on the node. the properties property should just be a getter on the node.properties
	readonly node: BufferedAudioNode;
	readonly properties: P;

	private renderEvents?: RenderEvents;
	private identity?: NodeIdentity;
	private quantumFraction = DEFAULT_PROGRESS_QUANTUM;

	private destroyed = false;

	private readonly lastBoundaryByPhase = new Map<StreamPhase, number>(); // FIX: Can you explain why we are having to track this state?

	constructor(node: BufferedAudioNode) {
		// FIX: We should be receiving a render context here with events, and startedAt so we can track elapsed since render start internally.
		this.node = node;
		this.properties = { ...node.properties } as P;
	}

	bind(events: RenderEvents, identity: NodeIdentity, quantumFraction: number): void {
		this.renderEvents = events;
		this.identity = identity;
		this.quantumFraction = quantumFraction;
	} // FIX: Eliminating this method will reduce a lot of complexity. We should look to have everything set either in the constructor or in the setup phase instead of creating another bind "stage". events and quantumFraction seem like they can be passed in a construction. im not sure of what identity is or it's justification, can you explain it to me? can't we generate an id at construction, move this all to the constructor, and get rid of all these null checks below?

	protected emitStarted(): void {
		// FIX: We should be setting a startedAt here so we can track elapsedMs in progress and finished
		if (this.identity) this.renderEvents?.emit("started", this.identity);
	}

	protected emitFinished(payload: FinishedPayload): void {
		if (this.identity) this.renderEvents?.emit("finished", this.identity, payload);
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
	} // FIX: I don't like this shorthand. Node creators are responsible for doing their own logging in process, but it's feasible that they are extending and modifying other phases too. locking "progress" to just one phase may be misleading, we should just use emitProgress directly instead.

	async destroy(): Promise<void> {
		if (this.destroyed) return;

		this.destroyed = true;

		await this._destroy();
	}

	_destroy(): Promise<void> | void {
		return;
	}
}
