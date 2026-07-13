import { z } from "zod";
import type { BufferedStream, StreamContext } from "./stream";

export interface BufferedAudioNodeProperties {
	readonly id?: string;
	readonly packageVersion?: string;
	readonly bypass?: boolean;
	readonly children?: ReadonlyArray<BufferedAudioNode>;
}

export type BufferedAudioNodeInput<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> = Partial<P> & BufferedAudioNodeProperties;

export interface Composition {
	readonly head: BufferedAudioNode;
	readonly tail: BufferedAudioNode;
}

function parseNodeProperties<P extends BufferedAudioNodeProperties>(schema: z.ZodType, value: unknown, nodeName: string): P {
	try {
		return schema.parse(value) as P;
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw new Error(`Invalid parameters for node "${nodeName}": ${error.message}`);
		}

		throw error;
	}
}

export abstract class BufferedAudioNode<P extends BufferedAudioNodeProperties = BufferedAudioNodeProperties> {
	static readonly packageName: string;
	static readonly apiVersion: number = 1;
	static readonly nodeName: string;
	static readonly description: string = "";
	static readonly schema: z.ZodType = z.object({});

	static readonly Stream: new (node: never, context: StreamContext) => BufferedStream;

	properties: P;

	constructor(properties?: BufferedAudioNodeInput<P>) {
		const constructor = this.constructor as typeof BufferedAudioNode;

		const parsed = parseNodeProperties<P>(constructor.schema, properties ?? {}, constructor.nodeName);

		this.properties = { ...properties, ...parsed };
	}

	get id(): string | undefined {
		return this.properties.id;
	}

	get packageVersion(): string | undefined {
		return this.properties.packageVersion;
	}

	get isBypassed(): boolean {
		return this.properties.bypass === true;
	}

	get children(): ReadonlyArray<BufferedAudioNode> {
		return this.properties.children ?? [];
	}
}
