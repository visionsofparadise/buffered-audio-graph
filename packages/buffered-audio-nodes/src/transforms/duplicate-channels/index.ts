import { z } from "zod";
import { BufferedTransformStream, TransformNode, type AudioChunk, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	channels: z.number().int().min(2).max(8).default(2).describe("Output channel count"),
});

export interface DuplicateChannelsProperties extends z.infer<typeof schema>, TransformNodeProperties {}

/**
 * Duplicate a single mono channel into N identical output channels.
 * Requires exactly 1 input channel; throws for any other channel count.
 */
export class DuplicateChannelsStream extends BufferedTransformStream<DuplicateChannelsProperties> {
	override _unbuffer(chunk: AudioChunk): AudioChunk {
		const inputChannels = chunk.samples.length;

		if (inputChannels !== 1) {
			throw new Error(`DuplicateChannelsNode requires exactly 1 input channel, got ${inputChannels}`);
		}

		const source = chunk.samples[0] ?? new Float32Array(0);
		const outputCount = this.properties.channels;
		const samples: Array<Float32Array> = [];

		for (let ch = 0; ch < outputCount; ch++) {
			samples.push(Float32Array.from(source));
		}

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class DuplicateChannelsNode extends TransformNode<DuplicateChannelsProperties> {
	static override readonly moduleName = "Duplicate Channels";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Duplicate a mono signal into multiple identical output channels";
	static override readonly schema = schema;
	static override is(value: unknown): value is DuplicateChannelsNode {
		return TransformNode.is(value) && value.type[2] === "duplicate-channels";
	}

	override readonly type = ["buffered-audio-node", "transform", "duplicate-channels"] as const;

	override createStream(): DuplicateChannelsStream {
		return new DuplicateChannelsStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<DuplicateChannelsProperties>): DuplicateChannelsNode {
		return new DuplicateChannelsNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function duplicateChannels(options?: { channels?: number; id?: string }): DuplicateChannelsNode {
	const parsed = schema.parse(options ?? {});

	return new DuplicateChannelsNode({ ...parsed, id: options?.id });
}
