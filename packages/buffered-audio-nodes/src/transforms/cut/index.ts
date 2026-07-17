import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME } from "../../package-metadata";
import { computeKeepRanges } from "./utils/regions";

const cutRegionSchema = z.object({
	start: z.number().min(0).max(86400).describe("Start (seconds)"),
	end: z.number().min(0).max(86400).describe("End (seconds)"),
});

export const schema = z.object({
	regions: z.array(cutRegionSchema).default([]).describe("Regions"),
});

export type CutRegion = z.infer<typeof cutRegionSchema>;

export interface CutProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class CutStream extends UnbufferedTransformStream<CutNode> {
	private sortedRegions: Array<CutRegion>;
	private removedFrames = 0;

	constructor(node: CutNode, context: StreamContext) {
		super(node, context);

		this.sortedRegions = [...this.properties.regions].sort((left, right) => left.start - right.start);
	}

	override *_transform(chunk: Block): Generator<Block> {
		const chunkFrames = chunk.samples[0]?.length ?? 0;
		const chunkStartSec = chunk.offset / chunk.sampleRate;
		const keepRanges = computeKeepRanges(this.sortedRegions, chunkStartSec, chunk.sampleRate, chunkFrames);

		if (keepRanges.length === 0) return;

		const totalKept = keepRanges.reduce((sum, range) => sum + (range.end - range.start), 0);

		const removedFrames = chunkFrames - totalKept;
		const adjustedOffset = chunk.offset - this.removedFrames;

		this.removedFrames += removedFrames;

		if (totalKept === chunkFrames) {
			yield { samples: chunk.samples, offset: adjustedOffset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };

			return;
		}

		const channels = chunk.samples.length;
		const output: Array<Float32Array> = [];

		for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
			const channel = chunk.samples[channelIndex];

			if (!channel) {
				output.push(new Float32Array(totalKept));
				continue;
			}

			const out = new Float32Array(totalKept);
			let writeOffset = 0;

			for (const range of keepRanges) {
				out.set(channel.subarray(range.start, range.end), writeOffset);
				writeOffset += range.end - range.start;
			}

			output.push(out);
		}

		yield { samples: output, offset: adjustedOffset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class CutNode extends TransformNode<CutProperties> {
	static override readonly nodeName = "Cut";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Remove a region of audio";
	static override readonly schema = schema;
	static override readonly Stream = CutStream;
}

export function cut(regions: Array<CutRegion>, options?: { id?: string }): CutNode {
	return new CutNode({ regions, id: options?.id });
}
