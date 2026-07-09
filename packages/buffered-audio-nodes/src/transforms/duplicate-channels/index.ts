import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	channels: z.number().int().min(2).max(8).default(2).describe("Output channel count"),
});

export interface DuplicateChannelsProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class DuplicateChannelsStream extends UnbufferedTransformStream<DuplicateChannelsNode> {
	override *_transform(chunk: Block): Generator<Block> {
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

		yield { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class DuplicateChannelsNode extends TransformNode<DuplicateChannelsProperties> {
	static override readonly nodeName = "Duplicate Channels";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Duplicate a mono signal into multiple identical output channels; requires exactly 1 input channel, throws otherwise";
	static override readonly schema = schema;
	static override readonly Stream = DuplicateChannelsStream;
}

export function duplicateChannels(options?: { channels?: number; id?: string }): DuplicateChannelsNode {
	return new DuplicateChannelsNode(options ?? {});
}
