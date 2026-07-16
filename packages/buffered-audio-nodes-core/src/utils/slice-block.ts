import type { Block } from "../node/stream/block";

export function sliceBlock(block: Block, offset: number, frames: number): Block {
	if (offset === 0 && frames === (block.samples[0]?.length ?? 0)) return block;

	return {
		samples: block.samples.map((channel) => channel.subarray(offset, offset + frames)),
		offset: block.offset + offset,
		sampleRate: block.sampleRate,
		bitDepth: block.bitDepth,
	};
}
