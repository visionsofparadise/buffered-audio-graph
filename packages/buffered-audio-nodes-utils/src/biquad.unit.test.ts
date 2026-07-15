import { describe, expect, it } from "vitest";
import {
	biquadFilter,
	zeroPhaseBiquadFilter,
	lowPassCoefficients,
	highPassCoefficients,
	preFilterCoefficients,
	rlbFilterCoefficients,
} from "./biquad";

describe("coefficient functions at 48kHz", () => {
	it("lowPassCoefficients has fa[0] = 1.0 and finite coefficients", () => {
		const { fb, fa } = lowPassCoefficients(48000, 1000);
		expect(fa[0]).toBe(1.0);
		for (const c of [...fb, ...fa]) expect(Number.isFinite(c)).toBe(true);
	});

	it("highPassCoefficients has fa[0] = 1.0 and finite coefficients", () => {
		const { fb, fa } = highPassCoefficients(48000, 1000);
		expect(fa[0]).toBe(1.0);
		for (const c of [...fb, ...fa]) expect(Number.isFinite(c)).toBe(true);
	});

	it("lowPassCoefficients produces different coefficients at quality=0.5 vs quality=2.0", () => {
		const low = lowPassCoefficients(48000, 1000, 0.5);
		const high = lowPassCoefficients(48000, 1000, 2.0);
		const allSame = low.fb.every((v, i) => v === high.fb[i]) && low.fa.every((v, i) => v === high.fa[i]);
		expect(allSame).toBe(false);
	});

	it("highPassCoefficients produces different coefficients at quality=0.5 vs quality=2.0", () => {
		const low = highPassCoefficients(48000, 1000, 0.5);
		const high = highPassCoefficients(48000, 1000, 2.0);
		const allSame = low.fb.every((v, i) => v === high.fb[i]) && low.fa.every((v, i) => v === high.fa[i]);
		expect(allSame).toBe(false);
	});
});

describe("preFilterCoefficients", () => {
	it("returns hardcoded BS.1770-4 constants at 48kHz", () => {
		const { fb, fa } = preFilterCoefficients(48000);
		expect(fb).toEqual([1.53512485958697, -2.69169618940638, 1.19839281085285]);
		expect(fa).toEqual([1.0, -1.69065929318241, 0.73248077421585]);
	});

	it("returns finite coefficients with fa[0] = 1.0 at non-48kHz rates", () => {
		for (const rate of [44100, 96000, 22050]) {
			const { fb, fa } = preFilterCoefficients(rate);
			expect(fa[0]).toBe(1.0);
			for (const c of [...fb, ...fa]) expect(Number.isFinite(c)).toBe(true);
		}
	});
});

describe("rlbFilterCoefficients", () => {
	it("returns hardcoded constants at 48kHz", () => {
		const { fb, fa } = rlbFilterCoefficients(48000);
		expect(fb).toEqual([1.0, -2.0, 1.0]);
		expect(fa).toEqual([1.0, -1.99004745483398, 0.99007225036621]);
	});

	it("returns finite coefficients with fa[0] = 1.0 at non-48kHz rates", () => {
		for (const rate of [44100, 96000, 22050]) {
			const { fb, fa } = rlbFilterCoefficients(rate);
			expect(fa[0]).toBe(1.0);
			for (const c of [...fb, ...fa]) expect(Number.isFinite(c)).toBe(true);
		}
	});
});

describe("biquadFilter", () => {
	it("passes DC and attenuates high frequency through a low-pass filter", () => {
		const sampleRate = 48000;
		const { fb, fa } = lowPassCoefficients(sampleRate, 200);
		const length = 4096;
		const signal = new Float32Array(length);

		for (let i = 0; i < length; i++) {
			signal[i] = 1.0 + Math.sin(2 * Math.PI * 10000 * i / sampleRate);
		}

		const output = biquadFilter(signal, fb, fa);

		const dcMean = output.slice(length / 2).reduce((s, v) => s + v, 0) / (length / 2);
		expect(dcMean).toBeCloseTo(1.0, 0);

		let hfEnergy = 0;
		for (let i = length / 2; i < length; i++) {
			const deviation = output[i]! - dcMean;
			hfEnergy += deviation * deviation;
		}
		const hfRms = Math.sqrt(hfEnergy / (length / 2));
		expect(hfRms).toBeLessThan(0.1);
	});

	it("returns a new array and does not mutate input", () => {
		const signal = new Float32Array([1, 2, 3, 4, 5]);
		const copy = Float32Array.from(signal);
		const { fb, fa } = lowPassCoefficients(48000, 1000);

		const output = biquadFilter(signal, fb, fa);

		expect(output).not.toBe(signal);
		expect(Array.from(signal)).toEqual(Array.from(copy));
	});
});

describe("zeroPhaseBiquadFilter", () => {
	it("mutates the input array in-place", () => {
		const signal = new Float32Array([0, 0, 0, 1, 0, 0, 0]);
		const original = signal;
		const coefficients = lowPassCoefficients(48000, 1000);

		zeroPhaseBiquadFilter(signal, coefficients);

		expect(signal).toBe(original);
		expect(signal[3]).not.toBe(1);
	});

	it("produces a symmetric response to an impulse (zero-phase property)", () => {
		const length = 256;
		const signal = new Float32Array(length);
		signal[length / 2] = 1.0;
		const coefficients = lowPassCoefficients(48000, 2000);

		zeroPhaseBiquadFilter(signal, coefficients);

		const center = length / 2;
		const checkRange = center / 2;
		for (let offset = 1; offset < checkRange; offset++) {
			expect(signal[center + offset]).toBeCloseTo(signal[center - offset]!, 4);
		}
	});
});
