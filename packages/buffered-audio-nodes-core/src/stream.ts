import { EventEmitter } from "node:events";
import type { BufferedAudioNodeProperties } from "./node";

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

export interface StreamEventMap {
	started: [];
	finished: [FinishedPayload];
	progress: [ProgressPayload];
	log: [LogPayload];
}

export const UNKNOWN_TOTAL_QUANTUM_FRAMES = 480_000;
export const DEFAULT_PROGRESS_QUANTUM = 0.1;

export abstract class BufferedStream<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> {
	readonly properties: P;
	readonly events = new EventEmitter<StreamEventMap>();

	quantumFraction = DEFAULT_PROGRESS_QUANTUM;

	private destroyed = false;

	private readonly lastBoundaryByPhase = new Map<StreamPhase, number>();

	constructor(properties: P) {
		this.properties = properties;
	}

	protected emitProgress(phase: StreamPhase, framesDone: number, framesTotal?: number, options?: { force?: boolean }): void {
		const total = framesTotal !== undefined && framesTotal > 0 ? framesTotal : undefined;

		if (options?.force) {
			this.lastBoundaryByPhase.set(phase, framesDone);
			this.events.emit("progress", { phase, framesDone, framesTotal: total });

			return;
		}

		const quantum = total ? Math.max(1, Math.floor(total * this.quantumFraction)) : UNKNOWN_TOTAL_QUANTUM_FRAMES;
		const boundary = Math.floor(framesDone / quantum) * quantum;
		const last = this.lastBoundaryByPhase.get(phase);

		if (last !== undefined && boundary <= last) return;

		this.lastBoundaryByPhase.set(phase, boundary);
		this.events.emit("progress", { phase, framesDone, framesTotal: total });
	}

	protected log(message: string, data?: Record<string, unknown>, level: "info" | "warn" = "info"): void {
		this.events.emit("log", { level, message, data });
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
