import { describe, expect, it } from "vitest";
import { fft, ifft, stft, istft, hanningWindow } from "./stft";

describe("fft/ifft round-trip", () => {
	for (const size of [64, 256, 1024]) {
		it(`reconstructs signal of size ${size} within 1e-6`, () => {
			const signal = new Float32Array(size);
			for (let i = 0; i < size; i++) {
				signal[i] = Math.sin(2 * Math.PI * 3 * i / size) + 0.5 * Math.cos(2 * Math.PI * 7 * i / size);
			}

			const { re, im } = fft(signal);
			const reconstructed = ifft(re, im);

			for (let i = 0; i < size; i++) {
				expect(Math.abs(reconstructed[i]! - signal[i]!)).toBeLessThan(1e-6);
			}
		});
	}
});

describe("fft known signal", () => {
	it("pure sine at bin frequency produces a dominant peak", () => {
		const fftSize = 256;
		const binIndex = 10;
		const signal = new Float32Array(fftSize);

		for (let i = 0; i < fftSize; i++) {
			signal[i] = Math.sin(2 * Math.PI * binIndex * i / fftSize);
		}

		const { re, im } = fft(signal);
		const halfSize = fftSize / 2 + 1;
		const magnitudes = new Float32Array(halfSize);

		for (let i = 0; i < halfSize; i++) {
			magnitudes[i] = Math.sqrt(re[i]! * re[i]! + im[i]! * im[i]!);
		}

		const peakMagnitude = magnitudes[binIndex]!;
		expect(peakMagnitude).toBeGreaterThan(fftSize / 4);

		for (let i = 0; i < halfSize; i++) {
			if (i !== binIndex && i !== fftSize - binIndex) {
				expect(magnitudes[i]!).toBeLessThan(peakMagnitude * 0.01);
			}
		}
	});
});

describe("Parseval's theorem", () => {
	it("energy is conserved through fft", () => {
		const size = 256;
		const signal = new Float32Array(size);
		for (let i = 0; i < size; i++) {
			signal[i] = Math.sin(2 * Math.PI * 5 * i / size) + 0.3 * Math.cos(2 * Math.PI * 20 * i / size);
		}

		let timeEnergy = 0;
		for (let i = 0; i < size; i++) {
			timeEnergy += signal[i]! * signal[i]!;
		}

		const { re, im } = fft(signal);
		let freqEnergy = 0;
		for (let i = 0; i < size; i++) {
			freqEnergy += re[i]! * re[i]! + im[i]! * im[i]!;
		}
		freqEnergy /= size;

		expect(freqEnergy).toBeCloseTo(timeEnergy, 4);
	});
});

describe("stft/istft round-trip", () => {
	it("reconstructs a multi-component signal within 1e-5 after trimming edges", () => {
		const sampleRate = 48000;
		const duration = 0.1;
		const length = Math.floor(sampleRate * duration);
		const signal = new Float32Array(length);

		for (let i = 0; i < length; i++) {
			const t = i / sampleRate;
			signal[i] = Math.sin(2 * Math.PI * 440 * t)
				+ 0.7 * Math.sin(2 * Math.PI * 1000 * t)
				+ 0.5 * Math.sin(2 * Math.PI * 2500 * t);
		}

		const fftSize = 1024;
		const hopSize = 256;
		const result = stft(signal, fftSize, hopSize);
		const reconstructed = istft(result, hopSize, length);

		const trimStart = fftSize;
		const trimEnd = length - fftSize;
		let maxError = 0;

		for (let i = trimStart; i < trimEnd; i++) {
			const error = Math.abs(reconstructed[i]! - signal[i]!);
			if (error > maxError) maxError = error;
		}

		expect(maxError).toBeLessThan(1e-5);
	});
});

describe("hanningWindow", () => {
	it("has correct length, edges near 0, center near 1, and is symmetric", () => {
		const size = 256;
		const window = hanningWindow(size);

		expect(window).toHaveLength(size);
		expect(window[0]).toBeCloseTo(0, 4);
		expect(window[size / 2]!).toBeCloseTo(1, 1);

		for (let i = 1; i < size / 2; i++) {
			expect(window[i]).toBeCloseTo(window[size - i]!, 6);
		}
	});

	it("returns the same instance for the same size (caching)", () => {
		const a = hanningWindow(512);
		const b = hanningWindow(512);
		expect(a).toBe(b);
	});
});

describe("stft output shape", () => {
	it("has correct frame count and frame lengths", () => {
		const signalLength = 4096;
		const fftSize = 512;
		const hopSize = 128;
		const signal = new Float32Array(signalLength);
		const expectedFrames = Math.floor((signalLength - fftSize) / hopSize) + 1;
		const halfSize = fftSize / 2 + 1;

		const result = stft(signal, fftSize, hopSize);

		expect(result.frames).toBe(expectedFrames);
		expect(result.real).toHaveLength(expectedFrames * halfSize);
		expect(result.imag).toHaveLength(expectedFrames * halfSize);
	});
});
