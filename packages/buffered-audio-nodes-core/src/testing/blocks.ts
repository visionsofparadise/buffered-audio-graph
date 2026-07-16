import type { Block } from "../node/stream/block";

export function createBlock(value: number, offset: number, frames: number, options?: { channels?: number; sampleRate?: number; bitDepth?: number }): Block {
	const channels = options?.channels ?? 1;
	const samples: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) samples.push(new Float32Array(frames).fill(value));

	return { samples, offset, sampleRate: options?.sampleRate ?? 44100, bitDepth: options?.bitDepth ?? 32 };
}

export function blockFromSamples(samples: Array<Float32Array>, offset: number, options?: { sampleRate?: number; bitDepth?: number }): Block {
	return { samples, offset, sampleRate: options?.sampleRate ?? 44100, bitDepth: options?.bitDepth ?? 32 };
}

export function channelSamples(blocks: Array<Block>, channel: number): Float32Array {
	const total = blocks.reduce((sum, block) => sum + (block.samples[channel]?.length ?? 0), 0);
	const out = new Float32Array(total);
	let offset = 0;

	for (const block of blocks) {
		const samples = block.samples[channel];

		if (!samples) continue;

		out.set(samples, offset);
		offset += samples.length;
	}

	return out;
}
