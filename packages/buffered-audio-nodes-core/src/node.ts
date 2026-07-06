import { z } from "zod";
import { DEFAULT_PROGRESS_QUANTUM, type BufferedStream, type FinishedPayload, type LogPayload, type ProgressPayload } from "./stream";

export interface AudioChunk {
	readonly samples: Array<Float32Array>;
	readonly offset: number;
	readonly sampleRate: number;
	readonly bitDepth: number;
}

export type ExecutionProvider = "gpu" | "cpu-native" | "cpu";

export interface NodeIdentity {
	readonly nodeName: string;
	readonly id?: string;
	readonly type: ReadonlyArray<string>;
}

export type StreamEvent =
	| { kind: "started" }
	| ({ kind: "finished" } & FinishedPayload)
	| ({ kind: "progress" } & ProgressPayload)
	| ({ kind: "log" } & LogPayload);

export function wireStreamEvents(stream: BufferedStream, identity: NodeIdentity, onEvent: (node: NodeIdentity, event: StreamEvent) => void): void {
	stream.events.on("started", () => onEvent(identity, { kind: "started" }));
	stream.events.on("finished", (payload) => onEvent(identity, { kind: "finished", ...payload }));
	stream.events.on("progress", (payload) => onEvent(identity, { kind: "progress", ...payload }));
	stream.events.on("log", (payload) => onEvent(identity, { kind: "log", ...payload }));
}

export function wireStream(node: BufferedAudioNode, stream: BufferedStream, context: StreamContext): void {
	stream.quantumFraction = context.progressQuantum ?? DEFAULT_PROGRESS_QUANTUM;

	if (!context.onEvent) return;

	const identity: NodeIdentity = { nodeName: (node.constructor as typeof BufferedAudioNode).nodeName, id: node.id, type: node.type };

	wireStreamEvents(stream, identity, context.onEvent);
}

export interface StreamContext {
	readonly executionProviders: ReadonlyArray<ExecutionProvider>;
	readonly memoryLimit: number;
	readonly durationFrames?: number;
	readonly highWaterMark: number;
	readonly signal?: AbortSignal;
	readonly visited: Set<BufferedAudioNode>;
	readonly onEvent?: (node: NodeIdentity, event: StreamEvent) => void;
	readonly progressQuantum?: number;
}

export interface RenderOptions {
	readonly chunkSize?: number;
	readonly highWaterMark?: number;
	readonly memoryLimit?: number;
	readonly signal?: AbortSignal;
	readonly executionProviders?: ReadonlyArray<ExecutionProvider>;
	readonly onEvent?: (node: NodeIdentity, event: StreamEvent) => void;
	readonly progressQuantum?: number;
}

export interface BufferedAudioNodeProperties {
	readonly id?: string;
	readonly bypass?: boolean;
	readonly previousProperties?: BufferedAudioNodeProperties;
	readonly bufferSize?: number;
	readonly latency?: number;
	readonly children?: ReadonlyArray<BufferedAudioNode>;
}

export type BufferedAudioNodeInput<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> = P;

export abstract class BufferedAudioNode<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> {
	static readonly packageName: string;
	static readonly packageVersion: string = "0.0.0";
	static readonly nodeName: string;
	static readonly nodeDescription: string = "";
	static readonly schema: z.ZodType = z.object({});

	abstract readonly type: ReadonlyArray<string>;

	static is(value: unknown): value is BufferedAudioNode {
		return typeof value === "object" && value !== null && "type" in value && Array.isArray(value.type) && value.type[0] === "buffered-audio-node";
	}

	properties: P;

	get id(): string | undefined {
		return this.properties.id;
	}

	get bufferSize(): number {
		return this.properties.bufferSize ?? 0;
	}
	get latency(): number {
		return this.properties.latency ?? 0;
	}

	get isBypassed(): boolean {
		return this.properties.bypass === true;
	}

	get children(): ReadonlyArray<BufferedAudioNode> {
		const raw = this.properties.children ?? [];
		const resolved: Array<BufferedAudioNode> = [];

		for (const child of raw) {
			if (child.isBypassed) {
				resolved.push(...child.children);
			} else {
				resolved.push(child);
			}
		}

		return resolved;
	}

	readonly streams: Array<BufferedStream> = [];

	constructor(properties?: P) {
		this.properties = {
			...properties,
		} as P;
	}

	abstract clone(overrides?: Partial<BufferedAudioNodeProperties>): BufferedAudioNode;

	async teardown(): Promise<void> {
		await this._teardown();

		for (const stream of this.streams) {
			await stream.teardown();
		}

		this.streams.length = 0;

		for (const child of this.children) {
			await child.teardown();
		}
	}

	_teardown(): Promise<void> | void {
		return;
	}
}
