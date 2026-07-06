import { z } from "zod";
import type { BufferedStream } from "./stream";

export interface Block {
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

export interface StreamContext {
	readonly executionProviders: ReadonlyArray<ExecutionProvider>;
	readonly memoryLimit: number;
	readonly durationFrames?: number;
	readonly highWaterMark: number;
	readonly signal?: AbortSignal;
	readonly progressQuantum?: number;
}

export interface RenderOptions {
	readonly chunkSize?: number;
	readonly highWaterMark?: number;
	readonly memoryLimit?: number;
	readonly signal?: AbortSignal;
	readonly executionProviders?: ReadonlyArray<ExecutionProvider>;
	readonly progressQuantum?: number;
}

export interface BufferedAudioNodeProperties {
	readonly id?: string;
	readonly bypass?: boolean;
	readonly previousProperties?: BufferedAudioNodeProperties;
	readonly children?: ReadonlyArray<BufferedAudioNode>;
}

export type BufferedAudioNodeInput<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> = Partial<P> & BufferedAudioNodeProperties;

export interface Composition {
	readonly head: BufferedAudioNode;
	readonly tail: BufferedAudioNode;
}

export abstract class BufferedAudioNode<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> {
	static readonly packageName: string;
	static readonly packageVersion: string = "0.0.0";
	static readonly nodeName: string;
	static readonly nodeDescription: string = "";
	static readonly schema: z.ZodType = z.object({});
	static readonly streamClass: new (node: BufferedAudioNode) => BufferedStream;

	abstract readonly type: ReadonlyArray<string>;

	static is(value: unknown): value is BufferedAudioNode {
		return typeof value === "object" && value !== null && "type" in value && Array.isArray(value.type) && value.type[0] === "buffered-audio-node";
	}

	properties: P;

	get id(): string | undefined {
		return this.properties.id;
	}

	get isBypassed(): boolean {
		return this.properties.bypass === true;
	}

	get children(): ReadonlyArray<BufferedAudioNode> {
		return this.properties.children ?? [];
	}

	constructor(properties?: BufferedAudioNodeInput<P>) {
		const ctor = this.constructor as typeof BufferedAudioNode;

		let parsed: unknown;

		try {
			parsed = ctor.schema.parse(properties ?? {});
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw new Error(`Invalid parameters for node "${ctor.nodeName}": ${error.message}`);
			}

			throw error;
		}

		this.properties = { ...properties, ...(parsed as Record<string, unknown>) } as P;
	}

	abstract clone(overrides?: Partial<BufferedAudioNodeProperties>): BufferedAudioNode;
}
