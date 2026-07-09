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
	static readonly nodeDescription: string = ""; // FIX: Change this to just "description"
	static readonly schema: z.ZodType = z.object({});

	static readonly Stream: new (node: BufferedAudioNode) => BufferedStream; // FIX: This was renamed streamNode -> Stream, needs to be propagated everywhere

	abstract readonly type: ReadonlyArray<string>;

	static is(value: unknown): value is BufferedAudioNode {
		return typeof value === "object" && value !== null && "type" in value && Array.isArray(value.type) && value.type[0] === "buffered-audio-node";
	} // FIX: We added this utility because of quirks around dynamically importing in things like the app at render time, however I'm going back on this being the place to put this. We should just have an abstract utility that asserts all nodes based on their static metadata properties.

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

			// FIX: This needs to assert the type of parsed such that we don't need to assert the type inline below.
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw new Error(`Invalid parameters for node "${ctor.nodeName}": ${error.message}`);
			}

			throw error;
		}

		this.properties = { ...properties, ...(parsed as Record<string, unknown>) } as P;
	}

	abstract clone(overrides?: Partial<BufferedAudioNodeProperties>): BufferedAudioNode;
	// FIX: I'm questioning if we need this anymore? Can you dig up the reasoning for why it exists? We can eliminate boilerplate from all nodes, and a test path for all nodes if we no longer need this.
}
