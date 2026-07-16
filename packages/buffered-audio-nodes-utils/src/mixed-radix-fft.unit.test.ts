import { describe, expect, it } from "vitest";
import { MixedRadixFft } from "./mixed-radix-fft";

const ORACLE_SIZES = [1, 2, 3, 5, 6, 10, 12, 15, 30, 60];

interface ComplexResult {
	readonly real: Float64Array;
	readonly imag: Float64Array;
}

function createComplexInput(size: number): { real: Float32Array; imag: Float32Array } {
	const real = new Float32Array(size);
	const imag = new Float32Array(size);

	for (let index = 0; index < size; index++) {
		real[index] = Math.sin(index * 0.37) + 0.2 * Math.cos(index * 1.13) + index * 0.003;
		imag[index] = 0.35 * Math.cos(index * 0.61) - 0.1 * Math.sin(index * 0.17);
	}

	return { real, imag };
}

function directTransform(real: ArrayLike<number>, imag: ArrayLike<number>, inverse = false): ComplexResult {
	const size = real.length;
	const outputReal = new Float64Array(size);
	const outputImag = new Float64Array(size);
	const direction = inverse ? 1 : -1;
	const scale = inverse ? 1 / size : 1;

	for (let bin = 0; bin < size; bin++) {
		let sumReal = 0;
		let sumImag = 0;

		for (let index = 0; index < size; index++) {
			const angle = direction * 2 * Math.PI * bin * index / size;
			const cosine = Math.cos(angle);
			const sine = Math.sin(angle);
			const inputReal = real[index] ?? 0;
			const inputImag = imag[index] ?? 0;

			sumReal += inputReal * cosine - inputImag * sine;
			sumImag += inputReal * sine + inputImag * cosine;
		}

		outputReal[bin] = sumReal * scale;
		outputImag[bin] = sumImag * scale;
	}

	return { real: outputReal, imag: outputImag };
}

function expectComplexClose(actualReal: ArrayLike<number>, actualImag: ArrayLike<number>, expected: ComplexResult, tolerance: number): void {
	let maxError = 0;

	for (let index = 0; index < expected.real.length; index++) {
		maxError = Math.max(
			maxError,
			Math.abs((actualReal[index] ?? 0) - (expected.real[index] ?? 0)),
			Math.abs((actualImag[index] ?? 0) - (expected.imag[index] ?? 0)),
		);
	}

	expect(maxError).toBeLessThan(tolerance);
}

describe("MixedRadixFft validation", () => {
	it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid size %s", (size) => {
		expect(() => new MixedRadixFft(size)).toThrow("positive integer");
	});

	it.each([7, 14, 22])("rejects unsupported prime factors in size %i", (size) => {
		expect(() => new MixedRadixFft(size)).toThrow("unsupported prime factor");
	});

	it("allows size one", () => {
		const fft = new MixedRadixFft(1);
		const outputReal = new Float32Array(1);
		const outputImag = new Float32Array(1);

		fft.fft(new Float32Array([0.75]), new Float32Array([-0.25]), outputReal, outputImag);

		expect(outputReal).toEqual(new Float32Array([0.75]));
		expect(outputImag).toEqual(new Float32Array([-0.25]));
	});

	it("rejects every undersized FFT array before output mutation", () => {
		const fft = new MixedRadixFft(6);
		const full = new Float32Array(6);
		const short = new Float32Array(5);
		const outputReal = new Float32Array(6).fill(9);
		const outputImag = new Float32Array(6).fill(8);

		expect(() => fft.fft(short, full, outputReal, outputImag)).toThrow("xRe capacity");
		expect(() => fft.fft(full, short, outputReal, outputImag)).toThrow("xIm capacity");
		expect(() => fft.fft(full, full, short, outputImag)).toThrow("outRe capacity");
		expect(() => fft.fft(full, full, outputReal, short)).toThrow("outIm capacity");
		expect(outputReal).toEqual(new Float32Array(6).fill(9));
		expect(outputImag).toEqual(new Float32Array(6).fill(8));
	});

	it("rejects every undersized inverse array before output mutation", () => {
		const fft = new MixedRadixFft(6);
		const full = new Float32Array(6);
		const short = new Float32Array(5);
		const outputReal = new Float32Array(6).fill(9);
		const outputImag = new Float32Array(6).fill(8);

		expect(() => fft.ifft(short, full, outputReal, outputImag)).toThrow("xRe capacity");
		expect(() => fft.ifft(full, short, outputReal, outputImag)).toThrow("xIm capacity");
		expect(() => fft.ifft(full, full, short, outputImag)).toThrow("outRe capacity");
		expect(() => fft.ifft(full, full, outputReal, short)).toThrow("outIm capacity");
		expect(outputReal).toEqual(new Float32Array(6).fill(9));
		expect(outputImag).toEqual(new Float32Array(6).fill(8));
	});

	it("accepts oversized arrays and leaves suffix capacity untouched", () => {
		const size = 6;
		const fft = new MixedRadixFft(size);
		const input = createComplexInput(8);
		const expected = directTransform(input.real.subarray(0, size), input.imag.subarray(0, size));
		const outputReal = new Float32Array(8).fill(99);
		const outputImag = new Float32Array(8).fill(98);

		fft.fft(input.real, input.imag, outputReal, outputImag);

		expectComplexClose(outputReal, outputImag, expected, 1e-4);
		expect(outputReal.subarray(size)).toEqual(new Float32Array([99, 99]));
		expect(outputImag.subarray(size)).toEqual(new Float32Array([98, 98]));
	});
});

describe("MixedRadixFft direct oracles", () => {
	it.each(ORACLE_SIZES)("matches every direct Float64 DFT bin for size %i", (size) => {
		const fft = new MixedRadixFft(size);
		const input = createComplexInput(size);
		const expected = directTransform(input.real, input.imag);
		const outputReal = new Float32Array(size);
		const outputImag = new Float32Array(size);

		fft.fft(input.real, input.imag, outputReal, outputImag);

		expectComplexClose(outputReal, outputImag, expected, 1e-4);
	});

	it.each(ORACLE_SIZES)("matches every direct Float64 inverse bin for size %i", (size) => {
		const fft = new MixedRadixFft(size);
		const input = createComplexInput(size);
		const expected = directTransform(input.real, input.imag, true);
		const outputReal = new Float32Array(size);
		const outputImag = new Float32Array(size);

		fft.ifft(input.real, input.imag, outputReal, outputImag);

		expectComplexClose(outputReal, outputImag, expected, 1e-4);
	});
});

describe("MixedRadixFft wide permutation", () => {
	it("matches analytical bins and inverse round-trip at size 75,000", () => {
		const size = 75000;
		const fft = new MixedRadixFft(size);
		const inputReal = new Float32Array(size);
		const inputImag = new Float32Array(size);
		const spectrumReal = new Float32Array(size);
		const spectrumImag = new Float32Array(size);

		inputReal[1] = 1;
		fft.fft(inputReal, inputImag, spectrumReal, spectrumImag);

		for (const bin of [0, 1, 2, 123, 32767, 65535, 74999]) {
			const angle = -2 * Math.PI * bin / size;

			expect(Math.abs((spectrumReal[bin] ?? 0) - Math.cos(angle))).toBeLessThan(1e-4);
			expect(Math.abs((spectrumImag[bin] ?? 0) - Math.sin(angle))).toBeLessThan(1e-4);
		}

		const reconstructedReal = new Float32Array(size);
		const reconstructedImag = new Float32Array(size);

		fft.ifft(spectrumReal, spectrumImag, reconstructedReal, reconstructedImag);

		let maxError = 0;

		for (let index = 0; index < size; index++) {
			maxError = Math.max(
				maxError,
				Math.abs((reconstructedReal[index] ?? 0) - (inputReal[index] ?? 0)),
				Math.abs(reconstructedImag[index] ?? 0),
			);
		}

		expect(maxError).toBeLessThan(1e-4);
	});
});
