import { TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";

export function measureFrameTruePeakDb(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const channelCount = channels.length;

	if (channelCount === 0) return linearToDb(0);

	const frames = channels[0]?.length ?? 0;
	const accumulator = new TruePeakAccumulator(sampleRate, channelCount, 4);

	accumulator.push(channels, frames);

	return linearToDb(accumulator.finalize());
}

