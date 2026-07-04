import { describe, expect, it } from "vitest";
import { preFilterCoefficients, rlbFilterCoefficients } from "./biquad";
import { KWeightedSquaredSum } from "./k-weighted-squared-sum";

function applyBiquadFloat64(samples: ReadonlyArray<number>, fb: ReadonlyArray<number>, fa: ReadonlyArray<number>): Array<number> {
	const out = new Array<number>(samples.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;

	for (let index = 0; index < samples.length; index++) {
		const x0 = samples[index] ?? 0;
		const y0 = (fb[0] ?? 0) * x0 + (fb[1] ?? 0) * x1 + (fb[2] ?? 0) * x2 - (fa[1] ?? 0) * y1 - (fa[2] ?? 0) * y2;

		out[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
	}

	return out;
}

function generateSine(frequency: number, amplitude: number, sampleRate: number, durationSeconds: number): Float32Array {
	const length = Math.floor(sampleRate * durationSeconds);
	const buffer = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		buffer[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
	}

	return buffer;
}

describe("KWeightedSquaredSum", () => {
	it("matches a manual K-weight cascade on a small signal", () => {
		// Cross-check the per-frame output against a manual two-stage biquad, validating the cascade (pre-filter → RLB → square) and default channel weighting.
		const sampleRate = 48000;
		const frames = 256;
		const input = new Float32Array(frames);

		for (let i = 0; i < frames; i++) {
			input[i] = Math.sin(0.13 * i) * 0.3 + Math.sin(0.07 * i) * 0.2;
		}

		const preFilter = preFilterCoefficients(sampleRate);
		const rlbFilter = rlbFilterCoefficients(sampleRate);

		// Reproduce the cascade in Float64 (Float32 input promoted) to match the implementation's numerical path.
		const inputAsArray = Array.from(input, (v) => v as number);
		const preFiltered = applyBiquadFloat64(inputAsArray, preFilter.fb, preFilter.fa);
		const filtered = applyBiquadFloat64(preFiltered, rlbFilter.fb, rlbFilter.fa);

		const accumulator = new KWeightedSquaredSum(sampleRate, 1);
		const output = new Float64Array(frames);

		accumulator.push([input], frames, output);

		for (let i = 0; i < frames; i++) {
			const expected = (filtered[i] ?? 0) * (filtered[i] ?? 0);

			expect(output[i]).toBeCloseTo(expected, 12);
		}
	});

	it("default weights of 1.0 each: stereo of identical input doubles the per-frame sum", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 0.05);
		const sineCopy = Float32Array.from(sine);
		const frames = sine.length;

		const mono = new KWeightedSquaredSum(sampleRate, 1);
		const stereo = new KWeightedSquaredSum(sampleRate, 2);

		const monoOut = new Float64Array(frames);
		const stereoOut = new Float64Array(frames);

		mono.push([sine], frames, monoOut);
		stereo.push([sine, sineCopy], frames, stereoOut);

		// Skip the first samples to let the biquad transient settle.
		for (let i = 100; i < frames; i++) {
			expect(stereoOut[i]).toBeCloseTo(2 * (monoOut[i] ?? 0), 12);
		}
	});

	it("explicit channelWeights are honoured: [1, 0] equals mono", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 0.05);
		const noise = new Float32Array(sine.length);

		for (let i = 0; i < noise.length; i++) {
			noise[i] = 0.5 * Math.sin((2 * Math.PI * 1500 * i) / sampleRate);
		}

		const frames = sine.length;
		const mono = new KWeightedSquaredSum(sampleRate, 1);
		const weighted = new KWeightedSquaredSum(sampleRate, 2, [1, 0]);

		const monoOut = new Float64Array(frames);
		const weightedOut = new Float64Array(frames);

		mono.push([sine], frames, monoOut);
		weighted.push([sine, noise], frames, weightedOut);

		for (let i = 100; i < frames; i++) {
			expect(weightedOut[i]).toBeCloseTo(monoOut[i] ?? 0, 12);
		}
	});

	it("chunked push parity: multiple pushes equal one big push", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 1);
		const frames = sine.length;

		const oneShot = new KWeightedSquaredSum(sampleRate, 1);
		const oneShotOut = new Float64Array(frames);

		oneShot.push([sine], frames, oneShotOut);

		const streamed = new KWeightedSquaredSum(sampleRate, 1);
		const streamedOut = new Float64Array(frames);
		const chunkSize = 4096;

		for (let offset = 0; offset < frames; offset += chunkSize) {
			const chunkFrames = Math.min(chunkSize, frames - offset);
			const slice = sine.subarray(offset, offset + chunkFrames);
			const view = streamedOut.subarray(offset, offset + chunkFrames);

			streamed.push([slice], chunkFrames, view);
		}

		for (let i = 0; i < frames; i++) {
			expect(streamedOut[i]).toBeCloseTo(oneShotOut[i] ?? 0, 12);
		}
	});

	it("validation: wrong channel count throws", () => {
		const accumulator = new KWeightedSquaredSum(48000, 2);
		const buf = new Float32Array(64);
		const out = new Float64Array(64);

		expect(() => accumulator.push([buf], 64, out)).toThrow(/2/);
	});

	it("validation: channel shorter than frames throws", () => {
		const accumulator = new KWeightedSquaredSum(48000, 1);
		const buf = new Float32Array(32);
		const out = new Float64Array(64);

		expect(() => accumulator.push([buf], 64, out)).toThrow(/fewer than the requested 64/);
	});

	it("validation: output shorter than frames throws", () => {
		const accumulator = new KWeightedSquaredSum(48000, 1);
		const buf = new Float32Array(64);
		const out = new Float64Array(32);

		expect(() => accumulator.push([buf], 64, out)).toThrow(/output buffer/);
	});

	it("constructor: non-positive channel count throws", () => {
		expect(() => new KWeightedSquaredSum(48000, 0)).toThrow(/positive/);
	});

	it("constructor: weight-length mismatch throws", () => {
		expect(() => new KWeightedSquaredSum(48000, 2, [1])).toThrow(/length 1/);
	});

	it("output preserves Float64 precision (round-trip through Float32 would lose bits)", () => {
		// 1e-20 signals produce ~1e-40 squared contributions, below Float32's smallest normal (~1.175e-38); they survive only with Float64 internals.
		const sampleRate = 48000;
		const frames = 256;
		const input = new Float32Array(frames);

		for (let i = 0; i < frames; i++) {
			input[i] = 1e-20 * Math.sin(0.1 * i);
		}

		const accumulator = new KWeightedSquaredSum(sampleRate, 1);
		const output = new Float64Array(frames);

		accumulator.push([input], frames, output);

		let foundSubFloat32 = false;

		for (let i = 100; i < frames; i++) {
			const value = output[i] ?? 0;

			if (value > 0 && value < 1e-38) foundSubFloat32 = true;
		}

		expect(foundSubFloat32).toBe(true);
	});
});
