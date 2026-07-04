import { describe, expect, it } from "vitest";
import { KWeightedSquaredSum } from "./k-weighted-squared-sum";
import { getLraConsideredMinLufs, IntegratedLufsAccumulator, LoudnessAccumulator, PreWeightedLoudnessAccumulator } from "./loudness";

function generateSine(frequency: number, amplitude: number, sampleRate: number, durationSeconds: number): Float32Array {
	const length = Math.floor(sampleRate * durationSeconds);
	const buffer = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		buffer[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
	}

	return buffer;
}

function measure(channels: ReadonlyArray<Float32Array>, sampleRate: number, channelWeights?: ReadonlyArray<number>): number {
	const accumulator = new IntegratedLufsAccumulator(sampleRate, channels.length, channelWeights);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return accumulator.finalize();
}

describe("IntegratedLufsAccumulator", () => {
	// EBU R128 reference: a 1 kHz sine at -20 dBFS peak (≈ -23 dBFS RMS) measures -23 LUFS; K-weighting's +0.7 dB at 1 kHz offsets the -0.691 LUFS_OFFSET plus RMS-to-LUFS bookkeeping.
	it("happy path: 1 kHz sine at -20 dBFS yields integrated LUFS within ±0.3 dB of -23", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const result = measure([sine], sampleRate);

		expect(result).toBeGreaterThan(-23.3);
		expect(result).toBeLessThan(-22.7);
	});

	it("silence returns -Infinity (everything fails absolute gate)", () => {
		const sampleRate = 48000;
		const silence = new Float32Array(sampleRate * 2);
		const result = measure([silence], sampleRate);

		expect(result).toBe(-Infinity);
	});

	it("relative gate excludes a silent tail: signal+silence ≈ active-region LUFS", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const silence = new Float32Array(sampleRate * 5);
		const combined = new Float32Array(sine.length + silence.length);

		combined.set(sine, 0);
		combined.set(silence, sine.length);

		const integrated = measure([combined], sampleRate);
		const activeOnly = measure([sine], sampleRate);

		// Without the relative gate the silent tail would drag integrated LUFS far below the active region; the gate keeps it close.
		expect(integrated).toBeGreaterThan(activeOnly - 1.0);
		expect(integrated).toBeLessThan(activeOnly + 1.0);
	});

	it("two identical channels are +3.01 dB louder than one (BS.1770 sums channel powers)", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		// Fresh copy for the second channel — biquad state is per-channel.
		const sineCopy = Float32Array.from(sine);

		const mono = measure([sine], sampleRate);
		const stereo = measure([sine, sineCopy], sampleRate);
		const delta = stereo - mono;

		expect(delta).toBeGreaterThan(3.01 - 0.1);
		expect(delta).toBeLessThan(3.01 + 0.1);
	});

	it("channelWeights [1, 0] on stereo equals mono on channel 0", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const noise = new Float32Array(sine.length);

		// Non-trivial signal in the zero-weighted channel so we'd notice if its weight weren't actually zeroed.
		for (let i = 0; i < noise.length; i++) {
			noise[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
		}

		const mono = measure([sine], sampleRate);
		const weighted = measure([sine, noise], sampleRate, [1, 0]);

		expect(Math.abs(weighted - mono)).toBeLessThan(0.01);
	});

	it("44.1 kHz and 48 kHz produce integrated LUFS within ~0.1 dB (prewarp path)", () => {
		const sine48 = generateSine(1000, 0.1, 48000, 5);
		const sine441 = generateSine(1000, 0.1, 44100, 5);

		const lufs48 = measure([sine48], 48000);
		const lufs441 = measure([sine441], 44100);

		expect(Math.abs(lufs48 - lufs441)).toBeLessThan(0.1);
	});

	// Streaming-equivalence catches biquad-state drift across push() boundaries and off-by-one errors in block open/close accounting.
	it("streaming in 4096-frame chunks matches one-shot to within 1e-6 dB", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const oneShot = measure([sine], sampleRate);

		const accumulator = new IntegratedLufsAccumulator(sampleRate, 1);
		const chunkFrames = 4096;

		for (let offset = 0; offset < sine.length; offset += chunkFrames) {
			const frames = Math.min(chunkFrames, sine.length - offset);
			const slice = sine.subarray(offset, offset + frames);

			accumulator.push([slice], frames);
		}

		const streamed = accumulator.finalize();

		expect(Math.abs(streamed - oneShot)).toBeLessThan(1e-6);
	});

	it("awkward 7777-frame chunks (misaligned to both blockSize and blockStep) match one-shot", () => {
		// blockSize=19200, blockStep=4800 @ 48 kHz; 7777 is coprime to both, so chunk boundaries land at every position in the block grid, exercising every off-by-one path.
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const oneShot = measure([sine], sampleRate);

		const accumulator = new IntegratedLufsAccumulator(sampleRate, 1);
		const chunkFrames = 7777;

		for (let offset = 0; offset < sine.length; offset += chunkFrames) {
			const frames = Math.min(chunkFrames, sine.length - offset);
			const slice = sine.subarray(offset, offset + frames);

			accumulator.push([slice], frames);
		}

		const streamed = accumulator.finalize();

		expect(Math.abs(streamed - oneShot)).toBeLessThan(1e-6);
	});

	it("last partial chunk (N-2 then 2 frames) matches one-shot", () => {
		// Catches off-by-one in `samplesProcessed` when a tiny tail chunk closes the final block(s).
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const oneShot = measure([sine], sampleRate);

		const accumulator = new IntegratedLufsAccumulator(sampleRate, 1);
		const headFrames = sine.length - 2;
		const head = sine.subarray(0, headFrames);
		const tail = sine.subarray(headFrames);

		accumulator.push([head], headFrames);
		accumulator.push([tail], 2);

		const streamed = accumulator.finalize();

		expect(Math.abs(streamed - oneShot)).toBeLessThan(1e-6);
	});
});

describe("getLraConsideredMinLufs", () => {
	it("empty input returns +Infinity", () => {
		expect(getLraConsideredMinLufs([])).toBe(Number.POSITIVE_INFINITY);
	});

	it("all blocks at -80 LUFS (below absolute gate) return +Infinity", () => {
		const shortTerm = [-80, -80, -80, -80];

		expect(getLraConsideredMinLufs(shortTerm)).toBe(Number.POSITIVE_INFINITY);
	});

	it("single block at -30 LUFS survives both gates and is returned as the min", () => {
		// One block: relative threshold = -30 + (-20) = -50; -30 > -50 → survives → min = -30.
		expect(getLraConsideredMinLufs([-30])).toBe(-30);
	});

	it("blocks [-20, -25, -30, -45, -60] yield min(considered) = -45", () => {
		// Linear-energy-mean relativeThreshold ≈ -45.466; under strict `>`, -45 survives and -60 is gated, so min(considered) = -45.
		expect(getLraConsideredMinLufs([-20, -25, -30, -45, -60])).toBe(-45);
	});

	it("blocks [-90, -85, -25] yield -25 (absolute gate drops -90 and -85)", () => {
		// -90/-85 fail the absolute gate; single survivor -25, relative threshold -45, so min = -25.
		expect(getLraConsideredMinLufs([-90, -85, -25])).toBe(-25);
	});

	it("agreement with computeLraFromShortTerm: on a non-trivial fixture where LRA > 0, returns a finite value within the absolute gate", () => {
		// Two concatenated sine tones at different amplitudes produce multiple short-term blocks spanning a real (>0) LRA.
		const sampleRate = 48000;
		const loudSine = generateSine(1000, 0.1, sampleRate, 6);
		const quietSine = generateSine(1000, 0.01, sampleRate, 6);
		const combined = new Float32Array(loudSine.length + quietSine.length);

		combined.set(loudSine, 0);
		combined.set(quietSine, loudSine.length);

		const accumulator = new LoudnessAccumulator(sampleRate, 1);

		accumulator.push([combined], combined.length);

		const result = accumulator.finalize();

		// A real LRA must be positive for the agreement check to be meaningful.
		expect(result.range).toBeGreaterThan(0);
		expect(result.shortTerm.length).toBeGreaterThan(0);

		const consideredMin = getLraConsideredMinLufs(result.shortTerm);

		// Helper must return a finite value within the absolute gate, and its min must be ≤ every considered block (≤ max short-term).
		expect(Number.isFinite(consideredMin)).toBe(true);
		expect(consideredMin).toBeGreaterThan(-70);
		expect(consideredMin).toBeLessThanOrEqual(Math.max(...result.shortTerm));
	});
});

describe("PreWeightedLoudnessAccumulator", () => {
	// Fed the same per-frame K-weighted squared sums that LoudnessAccumulator computes internally, the
	// pre-weighted path must reproduce LoudnessAccumulator's integrated LUFS + LRA bit-for-bit — it shares
	// the block-sum + BS.1770 gating + LRA logic and only skips the K-filter. This is the invariant the
	// loudnessTarget proxy measurement relies on.
	it("matches LoudnessAccumulator when fed the K-weighted squared sums directly", () => {
		const sampleRate = 48000;
		const loud = generateSine(220, 0.4, sampleRate, 6);
		const quiet = generateSine(220, 0.02, sampleRate, 6);
		const channelA = new Float32Array(loud.length + quiet.length);
		const channelB = new Float32Array(loud.length + quiet.length);

		channelA.set(loud, 0);
		channelA.set(quiet, loud.length);

		// Second channel scaled differently to exercise the channel-summed square.
		for (let i = 0; i < channelA.length; i++) channelB[i] = (channelA[i] ?? 0) * 0.5;

		const frames = channelA.length;
		const reference = new LoudnessAccumulator(sampleRate, 2);

		reference.push([channelA, channelB], frames);

		const referenceResult = reference.finalize();

		// Reproduce the per-frame kw² stream (what SourceMeasurementAccumulator persists via peekLastSquaredSums).
		const kw = new KWeightedSquaredSum(sampleRate, 2);
		const squaredSums = new Float64Array(frames);

		kw.push([channelA, channelB], frames, squaredSums);

		const proxy = new PreWeightedLoudnessAccumulator(sampleRate);

		proxy.push(squaredSums, frames);

		const proxyResult = proxy.finalize();

		expect(proxyResult.integrated).toBeCloseTo(referenceResult.integrated, 10);
		expect(proxyResult.range).toBeCloseTo(referenceResult.range, 10);
	});

	it("throws on push after finalize", () => {
		const accumulator = new PreWeightedLoudnessAccumulator(48000);

		accumulator.finalize();
		expect(() => accumulator.push(new Float64Array(10), 10)).toThrow("push() called after finalize()");
	});
});
