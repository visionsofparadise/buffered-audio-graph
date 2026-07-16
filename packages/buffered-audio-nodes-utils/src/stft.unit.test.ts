import { describe, expect, it } from "vitest";
import {
	bitReverse,
	butterflyStages,
	createFftWorkspace,
	fft,
	hanningWindow,
	ifft,
	istft,
	stft,
	type FftWorkspace,
} from "./stft";

interface ComplexResult {
	readonly real: Float64Array;
	readonly imag: Float64Array;
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

function createSignal(size: number): Float32Array {
	const signal = new Float32Array(size);

	for (let index = 0; index < size; index++) {
		signal[index] = Math.sin(index * 0.71) + 0.3 * Math.cos(index * 1.19) + index * 0.01;
	}

	return signal;
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

describe("radix-2 FFT", () => {
	it.each([1, 2, 4, 8, 16])("matches a direct Float64 DFT for real input of size %i", (size) => {
		const input = createSignal(size);
		const expected = directTransform(input, new Float64Array(size));
		const actual = fft(input);

		expectComplexClose(actual.re, actual.im, expected, 1e-5);
	});

	it.each([1, 2, 4, 8, 16])("matches a direct Float64 DFT for complex input of size %i", (size) => {
		const real = createSignal(size);
		const imag = new Float32Array(size);

		for (let index = 0; index < size; index++) imag[index] = Math.cos(index * 0.43) * 0.25;

		const expected = directTransform(real, imag);
		const actualReal = Float32Array.from(real);
		const actualImag = Float32Array.from(imag);

		bitReverse(actualReal, actualImag, size);
		butterflyStages(actualReal, actualImag, size);

		expectComplexClose(actualReal, actualImag, expected, 1e-5);
	});

	it.each([1, 2, 4, 8, 16])("matches a direct Float64 inverse for complex spectrum of size %i", (size) => {
		const real = createSignal(size);
		const imag = new Float32Array(size);

		for (let index = 0; index < size; index++) imag[index] = Math.sin(index * 0.53) * 0.4;

		const expected = directTransform(real, imag, true);
		const actual = ifft(real, imag);
		let maxError = 0;

		for (let index = 0; index < size; index++) {
			maxError = Math.max(maxError, Math.abs((actual[index] ?? 0) - (expected.real[index] ?? 0)));
		}

		expect(maxError).toBeLessThan(1e-5);
	});
});

describe("radix-2 validation", () => {
	it.each([0, -2, 1.5, 3, 6, 2 ** 32 + 1])("rejects invalid declared size %s across declared-size owners", (size) => {
		const values = new Float32Array(8);

		expect(() => createFftWorkspace(size)).toThrow("positive power-of-two integer");
		expect(() => stft(values, size, 1)).toThrow("positive power-of-two integer");
		expect(() => istft({ real: values, imag: values, frames: 0, fftSize: size }, 1, 0)).toThrow("positive power-of-two integer");
		expect(() => bitReverse(values, values, size)).toThrow("positive power-of-two integer");
		expect(() => butterflyStages(values, values, size)).toThrow("positive power-of-two integer");
	});

	it("rejects invalid input-derived FFT sizes", () => {
		expect(() => fft(new Float32Array(0))).toThrow("positive power-of-two integer");
		expect(() => fft(new Float32Array(3))).toThrow("positive power-of-two integer");
		expect(() => ifft(new Float32Array(3), new Float32Array(3))).toThrow("positive power-of-two integer");
	});

	it.each([0, -1, 1.5])("rejects invalid hop size %s", (hopSize) => {
		const result = { real: new Float32Array(3), imag: new Float32Array(3), frames: 1, fftSize: 4 };

		expect(() => stft(new Float32Array(8), 4, hopSize)).toThrow("positive integer");
		expect(() => istft(result, hopSize, 4)).toThrow("positive integer");
	});

	it("rejects mismatched complex arrays before mutation", () => {
		const real = new Float32Array([1, 2, 3, 4]);
		const reference = Float32Array.from(real);

		expect(() => ifft(real, new Float32Array(3))).toThrow("lengths must match");
		expect(() => bitReverse(real, new Float32Array(3), 4)).toThrow("complex-array capacity");
		expect(() => butterflyStages(real, new Float32Array(3), 4)).toThrow("complex-array capacity");
		expect(real).toEqual(reference);
	});

	it("rejects undersized workspaces before mutation", () => {
		const input = new Float32Array([1, 2, 3, 4]);
		const workspace: FftWorkspace = {
			re: new Float32Array(3),
			im: new Float32Array(4),
			outRe: new Float32Array(4),
			outIm: new Float32Array(4),
		};

		workspace.im.fill(9);

		expect(() => fft(input, workspace)).toThrow("workspace re capacity");
		expect(workspace.im).toEqual(new Float32Array([9, 9, 9, 9]));
	});

	it("rejects undersized STFT and ISTFT arrays", () => {
		const output = { real: new Float32Array(8), imag: new Float32Array(8) };
		const result = { real: new Float32Array(5), imag: new Float32Array(5), frames: 2, fftSize: 4 };

		expect(() => stft(new Float32Array(8), 4, 2, output)).toThrow("output capacity");
		expect(() => istft(result, 2, 8)).toThrow("spectrum capacity");
	});
});

describe("Hann window", () => {
	it("defines both size-one modes as one", () => {
		expect(hanningWindow(1, true)).toEqual(new Float32Array([1]));
		expect(hanningWindow(1, false)).toEqual(new Float32Array([1]));
	});

	it.each([0, -1, 1.5])("rejects invalid size %s", (size) => {
		expect(() => hanningWindow(size)).toThrow("positive integer");
	});

	it("returns the same cached instance", () => {
		expect(hanningWindow(512)).toBe(hanningWindow(512));
	});
});

describe("STFT and ISTFT", () => {
	it("produce an exact one-bin size-one transform and reconstruction", () => {
		const signal = new Float32Array([0.75]);
		const result = stft(signal, 1, 1);

		expect(result.frames).toBe(1);
		expect(result.real).toEqual(new Float32Array([0.75]));
		expect(result.imag).toEqual(new Float32Array([0]));
		expect(istft(result, 1, 1)).toEqual(signal);
	});

	it("reconstructs a multi-component signal within 1e-5 away from the edges", () => {
		const signal = createSignal(4096);
		const result = stft(signal, 256, 64);
		const reconstructed = istft(result, 64, signal.length);
		let maxError = 0;

		for (let index = 256; index < signal.length - 256; index++) {
			maxError = Math.max(maxError, Math.abs((reconstructed[index] ?? 0) - (signal[index] ?? 0)));
		}

		expect(maxError).toBeLessThan(1e-5);
	});
});
