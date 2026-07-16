import { describe, expect, it } from "vitest";
import { IntegratedLufsAccumulator } from "./loudness";

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

	it("full-scale mono 997 Hz measures within 0.1 LU of -3.01 LKFS", () => {
		const sampleRate = 48000;
		const sine = generateSine(997, 1, sampleRate, 5);
		const result = measure([sine], sampleRate);

		expect(Math.abs(result - -3.01)).toBeLessThanOrEqual(0.1);
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
