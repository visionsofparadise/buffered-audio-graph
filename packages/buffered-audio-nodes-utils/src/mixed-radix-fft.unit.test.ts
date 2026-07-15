import { describe, expect, it } from "vitest";
import { MixedRadixFft } from "./mixed-radix-fft";
import { fft } from "./stft";

describe("MixedRadixFft construction", () => {
	it("constructs for sizes 12, 30, 60, 8", () => {
		for (const size of [12, 30, 60, 8]) {
			expect(() => new MixedRadixFft(size)).not.toThrow();
		}
	});

	it("throws for size 7 (unsupported prime factor)", () => {
		expect(() => new MixedRadixFft(7)).toThrow();
	});
});

describe("MixedRadixFft fft forward transform", () => {
	it("produces finite output for sizes 12, 30, 60", () => {
		for (const size of [12, 30, 60]) {
			const mrfft = new MixedRadixFft(size);
			const signal = new Float32Array(size);

			for (let i = 0; i < size; i++) {
				signal[i] = Math.sin(2 * Math.PI * 2 * i / size);
			}

			const zeroIm = new Float32Array(size);
			const fftRe = new Float32Array(size);
			const fftIm = new Float32Array(size);
			mrfft.fft(signal, zeroIm, fftRe, fftIm);

			for (let i = 0; i < size; i++) {
				expect(Number.isFinite(fftRe[i])).toBe(true);
				expect(Number.isFinite(fftIm[i])).toBe(true);
			}
		}
	});
});

describe("MixedRadixFft known signal", () => {
	it("sine at bin frequency produces peak at expected bin for size 30", () => {
		const size = 30;
		const binIndex = 3;
		const mrfft = new MixedRadixFft(size);
		const signal = new Float32Array(size);

		for (let i = 0; i < size; i++) {
			signal[i] = Math.sin(2 * Math.PI * binIndex * i / size);
		}

		const zeroIm = new Float32Array(size);
		const fftRe = new Float32Array(size);
		const fftIm = new Float32Array(size);
		mrfft.fft(signal, zeroIm, fftRe, fftIm);

		const magnitudes = new Float32Array(size);
		for (let i = 0; i < size; i++) {
			magnitudes[i] = Math.sqrt(fftRe[i]! * fftRe[i]! + fftIm[i]! * fftIm[i]!);
		}

		const peakMagnitude = magnitudes[binIndex]!;
		const mirrorMagnitude = magnitudes[size - binIndex]!;
		const peakMax = Math.max(peakMagnitude, mirrorMagnitude);
		expect(peakMax).toBeGreaterThan(size / 4);
	});
});

describe("MixedRadixFft Parseval's theorem", () => {
	it("conserves energy for size 60", () => {
		const size = 60;
		const mrfft = new MixedRadixFft(size);
		const signal = new Float32Array(size);

		for (let i = 0; i < size; i++) {
			signal[i] = Math.sin(2 * Math.PI * 4 * i / size) + 0.3 * Math.cos(2 * Math.PI * 11 * i / size);
		}

		let timeEnergy = 0;
		for (let i = 0; i < size; i++) {
			timeEnergy += signal[i]! * signal[i]!;
		}

		const zeroIm = new Float32Array(size);
		const fftRe = new Float32Array(size);
		const fftIm = new Float32Array(size);
		mrfft.fft(signal, zeroIm, fftRe, fftIm);

		let freqEnergy = 0;
		for (let i = 0; i < size; i++) {
			freqEnergy += fftRe[i]! * fftRe[i]! + fftIm[i]! * fftIm[i]!;
		}
		freqEnergy /= size;

		expect(freqEnergy).toBeCloseTo(timeEnergy, 4);
	});
});

describe("MixedRadixFft cross-check against power-of-2 FFT", () => {
	it("size 8 produces same total energy as fft() from stft.ts", () => {
		const size = 8;
		const mrfft = new MixedRadixFft(size);
		const signal = new Float32Array(size);

		for (let i = 0; i < size; i++) {
			signal[i] = Math.sin(2 * Math.PI * 2 * i / size) + 0.7 * Math.cos(2 * Math.PI * 3 * i / size);
		}

		const zeroIm = new Float32Array(size);
		const mrRe = new Float32Array(size);
		const mrIm = new Float32Array(size);
		mrfft.fft(signal, zeroIm, mrRe, mrIm);

		const { re: stdRe, im: stdIm } = fft(signal);

		let mrTotalEnergy = 0;
		let stdTotalEnergy = 0;
		for (let i = 0; i < size; i++) {
			mrTotalEnergy += mrRe[i]! * mrRe[i]! + mrIm[i]! * mrIm[i]!;
			stdTotalEnergy += stdRe[i]! * stdRe[i]! + stdIm[i]! * stdIm[i]!;
		}

		expect(mrTotalEnergy).toBeCloseTo(stdTotalEnergy, 4);
	});
});

describe("MixedRadixFft ifft", () => {
	it("ifft produces finite output", () => {
		const size = 30;
		const mrfft = new MixedRadixFft(size);
		const signal = new Float32Array(size);

		for (let i = 0; i < size; i++) {
			signal[i] = Math.sin(2 * Math.PI * 2 * i / size);
		}

		const zeroIm = new Float32Array(size);
		const fftRe = new Float32Array(size);
		const fftIm = new Float32Array(size);
		mrfft.fft(signal, zeroIm, fftRe, fftIm);

		const outRe = new Float32Array(size);
		const outIm = new Float32Array(size);
		mrfft.ifft(fftRe, fftIm, outRe, outIm);

		for (let i = 0; i < size; i++) {
			expect(Number.isFinite(outRe[i])).toBe(true);
			expect(Number.isFinite(outIm[i])).toBe(true);
		}
	});

	it("fft/ifft round-trip reconstructs signal for sizes 12, 30, 60", () => {
		for (const size of [12, 30, 60]) {
			const mrfft = new MixedRadixFft(size);
			const signal = new Float32Array(size);

			for (let i = 0; i < size; i++) {
				signal[i] = Math.sin(2 * Math.PI * 2 * i / size) + 0.5 * Math.cos(2 * Math.PI * 5 * i / size);
			}

			const zeroIm = new Float32Array(size);
			const fftRe = new Float32Array(size);
			const fftIm = new Float32Array(size);
			mrfft.fft(signal, zeroIm, fftRe, fftIm);

			const outRe = new Float32Array(size);
			const outIm = new Float32Array(size);
			mrfft.ifft(fftRe, fftIm, outRe, outIm);

			for (let i = 0; i < size; i++) {
				expect(outRe[i]).toBeCloseTo(signal[i]!, 4);
			}
		}
	});

	it("real-valued input produces near-zero imaginary output", () => {
		const size = 30;
		const mrfft = new MixedRadixFft(size);
		const signal = new Float32Array(size);

		for (let i = 0; i < size; i++) {
			signal[i] = Math.sin(2 * Math.PI * 3 * i / size);
		}

		const zeroIm = new Float32Array(size);
		const fftRe = new Float32Array(size);
		const fftIm = new Float32Array(size);
		mrfft.fft(signal, zeroIm, fftRe, fftIm);

		const outRe = new Float32Array(size);
		const outIm = new Float32Array(size);
		mrfft.ifft(fftRe, fftIm, outRe, outIm);

		for (let i = 0; i < size; i++) {
			expect(Math.abs(outIm[i]!)).toBeLessThan(1e-5);
		}
	});
});
