import { z } from "zod";
import { BufferedTransformStream, type BlockBuffer, TransformNode, WHOLE_FILE, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME } from "../../package-metadata";
import { computeTrimRegion, findFirstAbove, findLastAbove } from "./utils/silence";

export const schema = z.object({
	threshold: z.number().min(0).max(1).multipleOf(0.001).default(0.001).describe("Threshold"),
	margin: z.number().min(0).max(1).multipleOf(0.001).default(0.01).describe("Margin"),
	start: z.boolean().default(true).describe("Start"),
	end: z.boolean().default(true).describe("End"),
});

export interface TrimProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class TrimStream extends BufferedTransformStream<TrimNode> {
	override blockSize = WHOLE_FILE;

	private firstAbove = Infinity;
	private lastAbove = -1;
	private scanOffset = 0;

	override _prepare(block: Block): Block {
		const chunkFrames = block.samples[0]?.length ?? 0;

		if (chunkFrames === 0) return block;

		const threshold = this.properties.threshold;
		const localFirst = findFirstAbove(block.samples, chunkFrames, threshold);

		if (localFirst < chunkFrames) {
			const abs = this.scanOffset + localFirst;

			if (abs < this.firstAbove) this.firstAbove = abs;
			this.lastAbove = Math.max(this.lastAbove, this.scanOffset + findLastAbove(block.samples, chunkFrames, threshold));
		}

		this.scanOffset += chunkFrames;

		return block;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const frames = buffered.frames;
		const channels = buffered.channels;

		if (channels === 0 || frames === 0) return;

		const sr = buffered.sampleRate ?? 44100;
		const marginFrames = Math.round(this.properties.margin * sr);
		const region = computeTrimRegion(this.firstAbove, this.lastAbove, frames, marginFrames, this.properties.start, this.properties.end);

		if (region === undefined) return;

		const { startFrame, endFrame } = region;

		for await (const block of buffered.iterate(44100)) {
			const blockFrames = block.samples[0]?.length ?? 0;
			const chunkStart = block.offset;
			const chunkEnd = chunkStart + blockFrames;
			const overlapStart = Math.max(chunkStart, startFrame);
			const overlapEnd = Math.min(chunkEnd, endFrame);

			if (overlapEnd <= overlapStart) continue;

			if (overlapStart === chunkStart && overlapEnd === chunkEnd) {
				yield { samples: block.samples, offset: chunkStart - startFrame, sampleRate: block.sampleRate, bitDepth: block.bitDepth };

				continue;
			}

			const sliceStart = overlapStart - chunkStart;
			const sliceEnd = overlapEnd - chunkStart;

			yield {
				samples: block.samples.map((channel) => channel.subarray(sliceStart, sliceEnd)),
				offset: overlapStart - startFrame,
				sampleRate: block.sampleRate,
				bitDepth: block.bitDepth,
			};
		}
	}
}

export class TrimNode extends TransformNode<TrimProperties> {
	static override readonly nodeName = "Trim";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Remove silence from start and end";
	static override readonly schema = schema;
	static override readonly Stream = TrimStream;
}

export function trim(options?: { threshold?: number; margin?: number; start?: boolean; end?: boolean; id?: string }): TrimNode {
	return new TrimNode(options ?? {});
}
