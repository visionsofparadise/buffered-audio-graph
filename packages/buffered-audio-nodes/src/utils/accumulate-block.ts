import type { Block } from "@buffered-audio/core";

export interface BlockAccumulator {
	push(channels: ReadonlyArray<Float32Array>, frames: number): void;
}

export function accumulateBlock<T extends BlockAccumulator>(
	accumulator: T | undefined,
	block: Block,
	create: (sampleRate: number, channelCount: number) => T,
): T | undefined {
	const frames = block.samples[0]?.length ?? 0;
	const channelCount = block.samples.length;

	if (frames === 0 || channelCount === 0) return accumulator;

	const target = accumulator ?? create(block.sampleRate, channelCount);

	target.push(block.samples, frames);

	return target;
}
