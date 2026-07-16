import { beforeEach, describe, expect, it, vi } from "vitest";

interface ForwardCall {
	readonly batchCount: number;
	readonly inputLength: number;
	readonly realLength: number;
	readonly imagLength: number;
}

interface InverseCall {
	readonly batchCount: number;
	readonly realLength: number;
	readonly imagLength: number;
	readonly outputLength: number;
}

interface FakeAddon {
	batchFft(input: Float32Array, fftSize: number, batchCount: number): { re: Float32Array; im: Float32Array };
	batchIfft(real: Float32Array, imag: Float32Array, fftSize: number, batchCount: number): Float32Array;
	batchFftInto?(input: Float32Array, real: Float32Array, imag: Float32Array, fftSize: number, batchCount: number): void;
	batchIfftInto?(real: Float32Array, imag: Float32Array, output: Float32Array, fftSize: number, batchCount: number): void;
}

const backendState = vi.hoisted<{ addon?: FakeAddon }>(() => ({}));

vi.mock("./fft-backend", () => ({
	getFftAddon: () => backendState.addon ?? null,
}));

import { hanningWindow, istft, STFT_BATCH_SCRATCH_BYTES, stft } from "./stft";

function fillForward(input: Float32Array, real: Float32Array, imag: Float32Array, fftSize: number, batchCount: number): void {
	const halfSize = Math.floor(fftSize / 2) + 1;

	for (let frame = 0; frame < batchCount; frame++) {
		for (let bin = 0; bin < halfSize; bin++) {
			const value = (input[frame * fftSize + Math.min(2, fftSize - 1)] ?? 0) + bin;

			real[frame * halfSize + bin] = value;
			imag[frame * halfSize + bin] = -value;
		}
	}
}

function fillInverse(real: Float32Array, output: Float32Array, fftSize: number, batchCount: number): void {
	const halfSize = Math.floor(fftSize / 2) + 1;

	for (let frame = 0; frame < batchCount; frame++) {
		const value = real[frame * halfSize] ?? 0;

		for (let index = 0; index < fftSize; index++) output[frame * fftSize + index] = value;
	}
}

function createFakeAddon(useInto: boolean, forwardCalls: Array<ForwardCall>, inverseCalls: Array<InverseCall>): FakeAddon {
	const addon: FakeAddon = {
		batchFft(input, fftSize, batchCount) {
			const halfSize = Math.floor(fftSize / 2) + 1;
			const real = new Float32Array(halfSize * batchCount);
			const imag = new Float32Array(halfSize * batchCount);

			forwardCalls.push({ batchCount, inputLength: input.length, realLength: real.length, imagLength: imag.length });
			fillForward(input, real, imag, fftSize, batchCount);

			return { re: real, im: imag };
		},
		batchIfft(real, imag, fftSize, batchCount) {
			const output = new Float32Array(fftSize * batchCount);

			inverseCalls.push({ batchCount, realLength: real.length, imagLength: imag.length, outputLength: output.length });
			fillInverse(real, output, fftSize, batchCount);

			return output;
		},
	};

	if (useInto) {
		addon.batchFftInto = (input, real, imag, fftSize, batchCount) => {
			forwardCalls.push({ batchCount, inputLength: input.length, realLength: real.length, imagLength: imag.length });
			fillForward(input, real, imag, fftSize, batchCount);
		};
		addon.batchIfftInto = (real, imag, output, fftSize, batchCount) => {
			inverseCalls.push({ batchCount, realLength: real.length, imagLength: imag.length, outputLength: output.length });
			fillInverse(real, output, fftSize, batchCount);
		};
	}

	return addon;
}

function expectedOverlapValue(position: number, frames: number, fftSize: number, hopSize: number): number {
	const window = hanningWindow(fftSize);
	const firstFrame = Math.max(0, Math.ceil((position - fftSize + 1) / hopSize));
	const lastFrame = Math.min(frames - 1, Math.floor(position / hopSize));
	let sum = 0;
	let windowSum = 0;

	for (let frame = firstFrame; frame <= lastFrame; frame++) {
		const windowIndex = position - frame * hopSize;
		const windowValue = window[windowIndex] ?? 0;

		sum += (frame + 1) * windowValue;
		windowSum += windowValue * windowValue;
	}

	return windowSum > 1e-8 ? sum / windowSum : 0;
}

describe("native STFT slabs", () => {
	beforeEach(() => {
		backendState.addon = undefined;
	});

	it.each([true, false])("bounds forward scratch and places frames across slabs (into=%s)", (useInto) => {
		const fftSize = 4;
		const halfSize = Math.floor(fftSize / 2) + 1;
		const bytesPerFrame = Float32Array.BYTES_PER_ELEMENT * (fftSize + 2 * halfSize);
		const slabFrames = Math.floor(STFT_BATCH_SCRATCH_BYTES / bytesPerFrame);
		const frames = slabFrames + 3;
		const signal = new Float32Array(frames + fftSize - 1);
		const forwardCalls: Array<ForwardCall> = [];

		for (let index = 0; index < signal.length; index++) signal[index] = index % 997 / 997;

		backendState.addon = createFakeAddon(useInto, forwardCalls, []);

		const result = stft(signal, fftSize, 1, undefined, "fftw");

		expect(forwardCalls.map((call) => call.batchCount)).toEqual([slabFrames, 3]);

		for (const call of forwardCalls) {
			expect(call.batchCount * bytesPerFrame).toBeLessThanOrEqual(STFT_BATCH_SCRATCH_BYTES);
			expect(call.inputLength).toBe(call.batchCount * fftSize);
			expect(call.realLength).toBe(call.batchCount * halfSize);
			expect(call.imagLength).toBe(call.batchCount * halfSize);
		}

		for (const frame of [slabFrames - 1, slabFrames, frames - 1]) {
			for (let bin = 0; bin < halfSize; bin++) {
				const expected = (signal[frame + 2] ?? 0) + bin;

				expect(result.real[frame * halfSize + bin]).toBe(Math.fround(expected));
				expect(result.imag[frame * halfSize + bin]).toBe(Math.fround(-expected));
			}
		}
	});

	it.each([true, false])("bounds inverse scratch and overlap-adds across slabs (into=%s)", (useInto) => {
		const fftSize = 4;
		const hopSize = 2;
		const halfSize = Math.floor(fftSize / 2) + 1;
		const bytesPerFrame = Float32Array.BYTES_PER_ELEMENT * fftSize;
		const slabFrames = Math.floor(STFT_BATCH_SCRATCH_BYTES / bytesPerFrame);
		const frames = slabFrames + 3;
		const real = new Float32Array(frames * halfSize);
		const imag = new Float32Array(frames * halfSize);
		const outputLength = (frames - 1) * hopSize + fftSize;
		const inverseCalls: Array<InverseCall> = [];

		for (let frame = 0; frame < frames; frame++) real[frame * halfSize] = frame + 1;

		backendState.addon = createFakeAddon(useInto, [], inverseCalls);

		const output = istft({ real, imag, frames, fftSize }, hopSize, outputLength, "fftw");

		expect(inverseCalls.map((call) => call.batchCount)).toEqual([slabFrames, 3]);

		for (const call of inverseCalls) {
			expect(call.batchCount * bytesPerFrame).toBeLessThanOrEqual(STFT_BATCH_SCRATCH_BYTES);
			expect(call.realLength).toBe(call.batchCount * halfSize);
			expect(call.imagLength).toBe(call.batchCount * halfSize);
			expect(call.outputLength).toBe(call.batchCount * fftSize);
		}

		const boundary = slabFrames * hopSize;

		for (const position of [boundary - 1, boundary, boundary + 1, outputLength - 2]) {
			expect(Math.abs((output[position] ?? 0) - expectedOverlapValue(position, frames, fftSize, hopSize))).toBeLessThan(0.1);
		}
	});

	it("rejects one forward frame larger than the scratch cap", () => {
		const fftSize = 1024 * 1024;
		const forwardCalls: Array<ForwardCall> = [];

		backendState.addon = createFakeAddon(true, forwardCalls, []);

		expect(() => stft(new Float32Array(fftSize), fftSize, fftSize, undefined, "fftw")).toThrow("native scratch budget");
		expect(forwardCalls).toHaveLength(0);
	});
});
