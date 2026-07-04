import { TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";

// A FRESH TruePeakAccumulator per call is MANDATORY: (1) the per-channel upsampler's 12-tap history
// carries across pushes, so reusing one would let a prior frame contaminate this one; (2) finalize()
// returns a running max that only grows, so a reused accumulator could never report a lower peak.
export function measureFrameTruePeakDb(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const channelCount = channels.length;

	if (channelCount === 0) return linearToDb(0);

	const frames = channels[0]?.length ?? 0;
	const accumulator = new TruePeakAccumulator(sampleRate, channelCount, 4);

	accumulator.push(channels, frames);

	return linearToDb(accumulator.finalize());
}

