import type { Block, BlockBuffer } from "@buffered-audio/core";

export function applyGain(block: Block, gain: number): Block {
	const samples = block.samples.map((channel) => {
		const output = new Float32Array(channel.length);

		for (let index = 0; index < channel.length; index++) {
			output[index] = (channel[index] ?? 0) * gain;
		}

		return output;
	});

	return { samples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth };
}

export async function* iterateWithGain(
	buffered: BlockBuffer,
	gain: number,
	chunkFrames: number,
): AsyncGenerator<Block> {
	for await (const block of buffered.iterate(chunkFrames)) {
		if (gain === 1) {
			yield block;

			continue;
		}

		yield applyGain(block, gain);
	}
}
