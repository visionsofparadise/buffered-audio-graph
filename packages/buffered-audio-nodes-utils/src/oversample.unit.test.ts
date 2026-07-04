import { describe, it, expect } from "vitest";
import { Oversampler, type OversamplingFactor } from "./oversample";

const SAMPLE_RATE = 48000;
const FRAMES = 2048;

function rms(signal: Float32Array): number {
	let sum = 0;

	for (const sample of signal) {
		sum += sample * sample;
	}

	return Math.sqrt(sum / signal.length);
}

function makeDC(value: number, frames: number): Float32Array {
	return new Float32Array(frames).fill(value);
}

function makeSine(freqHz: number, frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		out[index] = Math.sin((2 * Math.PI * freqHz * index) / sampleRate);
	}

	return out;
}

describe("Oversampler", () => {
	describe("factor 1 pass-through", () => {
		it("upsample returns a copy (not same reference) with identical values", () => {
			const osr = new Oversampler(1, SAMPLE_RATE);
			const input = makeSine(1000, FRAMES, SAMPLE_RATE);
			const output = osr.upsample(input);

			expect(output).not.toBe(input);
			expect(output.length).toBe(input.length);

			for (let index = 0; index < input.length; index++) {
				expect(output[index]).toBe(input[index]);
			}
		});

		it("downsample returns a copy (not same reference) with identical values", () => {
			const osr = new Oversampler(1, SAMPLE_RATE);
			const input = makeSine(1000, FRAMES, SAMPLE_RATE);
			const output = osr.downsample(input);

			expect(output).not.toBe(input);
			expect(output.length).toBe(input.length);

			for (let index = 0; index < input.length; index++) {
				expect(output[index]).toBe(input[index]);
			}
		});

		it("oversample applies fn per sample and returns a fresh buffer", () => {
			const osr = new Oversampler(1, SAMPLE_RATE);
			const input = makeDC(0.25, FRAMES);
			const output = osr.oversample(input, (x) => x * 2);

			expect(output).not.toBe(input);
			expect(output.length).toBe(input.length);

			for (const sample of output) {
				expect(sample).toBeCloseTo(0.5, 6);
			}
		});

		it("methods do not touch state at factor 1", () => {
			const osr = new Oversampler(1, SAMPLE_RATE);
			const input = makeSine(1000, FRAMES, SAMPLE_RATE);

			const first = osr.oversample(input, (x) => x);

			for (let i = 0; i < 10; i++) {
				osr.oversample(input, (x) => x);
			}

			const later = osr.oversample(input, (x) => x);

			for (let index = 0; index < first.length; index++) {
				expect(later[index]).toBe(first[index]);
			}
		});

		it("reset() is safe to call at factor 1", () => {
			const osr = new Oversampler(1, SAMPLE_RATE);

			expect(() => osr.reset()).not.toThrow();

			const input = makeDC(0.5, FRAMES);
			const output = osr.oversample(input, (x) => x);

			for (const sample of output) {
				expect(sample).toBeCloseTo(0.5, 8);
			}
		});
	});

	const REAL_FACTORS: Array<OversamplingFactor> = [2, 4, 8];

	for (const factor of REAL_FACTORS) {
		describe(`factor ${factor}`, () => {
			it("oversample returns the same length output as input", () => {
				const osr = new Oversampler(factor, SAMPLE_RATE);
				const input = makeDC(0.5, FRAMES);
				const output = osr.oversample(input, (x) => x);

				expect(output.length).toBe(FRAMES);
			});

			it("upsample returns factor * input length", () => {
				const osr = new Oversampler(factor, SAMPLE_RATE);
				const input = makeDC(0.5, FRAMES);
				const up = osr.upsample(input);

				expect(up.length).toBe(FRAMES * factor);
			});

			it("downsample returns input length / factor", () => {
				const osr = new Oversampler(factor, SAMPLE_RATE);
				const up = new Float32Array(FRAMES * factor).fill(0.5);
				const down = osr.downsample(up);

				expect(down.length).toBe(FRAMES);
			});

			it("DC round-trips within tolerance via oversample()", () => {
				const osr = new Oversampler(factor, SAMPLE_RATE);
				const dcValue = 0.5;
				const input = makeDC(dcValue, FRAMES);

				for (let chunk = 0; chunk < 5; chunk++) {
					osr.oversample(input, (x) => x);
				}

				const output = osr.oversample(input, (x) => x);

				const halfStart = Math.floor(FRAMES / 2);
				let maxError = 0;

				for (let index = halfStart; index < FRAMES; index++) {
					maxError = Math.max(maxError, Math.abs((output[index] ?? 0) - dcValue));
				}

				expect(maxError).toBeLessThan(0.02);
			});

			it("low-frequency sinusoid passes through without significant attenuation", () => {
				const osr = new Oversampler(factor, SAMPLE_RATE);
				const signal = makeSine(100, FRAMES, SAMPLE_RATE);

				for (let chunk = 0; chunk < 3; chunk++) {
					osr.oversample(signal, (x) => x);
				}

				const output = osr.oversample(signal, (x) => x);

				const inRms = rms(signal);
				const outRms = rms(output);

				expect(outRms).toBeGreaterThan(inRms * 0.9);
			});

			it("high-frequency signal above cutoff is attenuated relative to passband", () => {
				const passbandHz = 1000;
				const cutoffHz = Math.round(SAMPLE_RATE * 0.45);

				const osr = new Oversampler(factor, SAMPLE_RATE);

				const passband = makeSine(passbandHz, FRAMES, SAMPLE_RATE);
				const cutoff = makeSine(cutoffHz, FRAMES, SAMPLE_RATE);

				for (let chunk = 0; chunk < 5; chunk++) {
					osr.oversample(passband, (x) => x);
				}

				const passbandOut = osr.oversample(passband, (x) => x);

				osr.reset();

				for (let chunk = 0; chunk < 5; chunk++) {
					osr.oversample(cutoff, (x) => x);
				}

				const cutoffOut = osr.oversample(cutoff, (x) => x);

				const half = Math.floor(FRAMES / 2);
				const cutoffRms = rms(cutoffOut.slice(half));
				const passbandRms = rms(passbandOut.slice(half));

				expect(cutoffRms).toBeLessThan(passbandRms * 0.9);
			});

			it("state continuity: chunked processing matches single-pass (steady-state RMS)", () => {
				const totalFrames = FRAMES * 4;
				const signal = makeSine(1000, totalFrames, SAMPLE_RATE);

				const refOsr = new Oversampler(factor, SAMPLE_RATE);
				const refOutput = refOsr.oversample(signal, (x) => x);

				const chunkedOsr = new Oversampler(factor, SAMPLE_RATE);
				const chunkedOutput = new Float32Array(totalFrames);

				for (let chunk = 0; chunk < 4; chunk++) {
					const start = chunk * FRAMES;
					const slice = signal.slice(start, start + FRAMES);
					const out = chunkedOsr.oversample(slice, (x) => x);

					chunkedOutput.set(out, start);
				}

				const halfStart = Math.floor(totalFrames / 2);
				const refRms = rms(refOutput.slice(halfStart));
				const chunkedRms = rms(chunkedOutput.slice(halfStart));

				expect(Math.abs(refRms - chunkedRms) / refRms).toBeLessThan(0.05);
			});

			it("all output samples are finite", () => {
				const osr = new Oversampler(factor, SAMPLE_RATE);
				const signal = makeSine(1000, FRAMES, SAMPLE_RATE);
				const output = osr.oversample(signal, (x) => x);

				for (const sample of output) {
					expect(Number.isFinite(sample)).toBe(true);
				}
			});
		});
	}

	describe("reset() clears state at factor > 1", () => {
		it("reset makes the filter re-start cold", () => {
			const osr = new Oversampler(2, SAMPLE_RATE);
			const signal = makeSine(1000, FRAMES, SAMPLE_RATE);

			for (let chunk = 0; chunk < 5; chunk++) {
				osr.oversample(signal, (x) => x);
			}

			const beforeReset = osr.oversample(signal, (x) => x);

			osr.reset();
			const afterReset = osr.oversample(signal, (x) => x);

			let identical = true;

			for (let index = 0; index < 20; index++) {
				if (Math.abs((beforeReset[index] ?? 0) - (afterReset[index] ?? 0)) > 1e-6) {
					identical = false;
					break;
				}
			}

			expect(identical).toBe(false);

			for (const sample of afterReset) {
				expect(Number.isFinite(sample)).toBe(true);
			}
		});
	});

	describe("nonlinear fn interaction", () => {
		it("soft-clip shaper produces bounded output through oversample()", () => {
			const softClip = (x: number): number => x / (1 + Math.abs(x));
			const osr = new Oversampler(2, SAMPLE_RATE);
			const signal = makeSine(1000, FRAMES, SAMPLE_RATE);

			for (let chunk = 0; chunk < 3; chunk++) {
				osr.oversample(signal, softClip);
			}

			const output = osr.oversample(signal, softClip);

			for (const sample of output) {
				expect(Number.isFinite(sample)).toBe(true);
				expect(Math.abs(sample)).toBeLessThan(2);
			}
		});

		it("oversampled output differs from non-oversampled for high-drive saturation", () => {
			const highDriveSoftClip = (x: number): number => {
				const driven = x * 20;

				return driven / (1 + Math.abs(driven));
			};

			const signal = makeSine(5000, FRAMES, SAMPLE_RATE);

			const directOutput = new Float32Array(FRAMES);

			for (let index = 0; index < FRAMES; index++) {
				directOutput[index] = highDriveSoftClip(signal[index] ?? 0);
			}

			const osr = new Oversampler(2, SAMPLE_RATE);

			for (let chunk = 0; chunk < 3; chunk++) {
				osr.oversample(signal, highDriveSoftClip);
			}

			const oversampledOutput = osr.oversample(signal, highDriveSoftClip);

			for (const sample of oversampledOutput) {
				expect(Number.isFinite(sample)).toBe(true);
			}

			const directRms = rms(directOutput);
			const oversampledRms = rms(oversampledOutput);

			expect(Math.abs(directRms - oversampledRms)).toBeGreaterThan(0.001);
		});
	});
});
