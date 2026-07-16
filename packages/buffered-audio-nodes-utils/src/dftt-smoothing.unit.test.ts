import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyDfttSmoothing,
	getDfttBatchBlockCount,
	type DfttParams,
	type DfttProfileMs,
} from "./dftt-smoothing";

interface AddonCall {
	readonly kind: "forward" | "inverse";
	readonly batchCount: number;
	readonly inputLength: number;
	readonly outputLength: number;
}

interface FakeAddon {
	batchFft2D(input: Float32Array, rows: number, columns: number, batchCount: number): { re: Float32Array; im: Float32Array };
	batchIfft2D(real: Float32Array, imaginary: Float32Array, rows: number, columns: number, batchCount: number): Float32Array;
}

const backendState = vi.hoisted<{ addon?: FakeAddon }>(() => ({}));

vi.mock("./fft-backend", () => ({
	getFftAddon: () => backendState.addon ?? null,
}));

const defaultParams: DfttParams = {
	blockFreq: 4,
	blockTime: 4,
	hopFreq: 2,
	hopTime: 2,
	threshold: 0.35,
};

function nonperiodicHann(size: number): Float64Array {
	if (size === 1) return Float64Array.of(1);

	return Float64Array.from({ length: size }, (_, index) => 0.5 * (1 - Math.cos(2 * Math.PI * index / (size - 1))));
}

function directDft2D(input: ArrayLike<number>, rows: number, columns: number): { re: Float64Array; im: Float64Array } {
	const real = new Float64Array(rows * columns);
	const imaginary = new Float64Array(rows * columns);

	for (let rowFrequency = 0; rowFrequency < rows; rowFrequency++) {
		for (let columnFrequency = 0; columnFrequency < columns; columnFrequency++) {
			let realSum = 0;
			let imaginarySum = 0;

			for (let row = 0; row < rows; row++) {
				for (let column = 0; column < columns; column++) {
					const angle = -2 * Math.PI * (rowFrequency * row / rows + columnFrequency * column / columns);
					const value = input[row * columns + column] ?? 0;

					realSum += value * Math.cos(angle);
					imaginarySum += value * Math.sin(angle);
				}
			}

			real[rowFrequency * columns + columnFrequency] = realSum;
			imaginary[rowFrequency * columns + columnFrequency] = imaginarySum;
		}
	}

	return { re: real, im: imaginary };
}

function directIdft2D(real: ArrayLike<number>, imaginary: ArrayLike<number>, rows: number, columns: number): Float64Array {
	const output = new Float64Array(rows * columns);

	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			let realSum = 0;

			for (let rowFrequency = 0; rowFrequency < rows; rowFrequency++) {
				for (let columnFrequency = 0; columnFrequency < columns; columnFrequency++) {
					const position = rowFrequency * columns + columnFrequency;
					const angle = 2 * Math.PI * (rowFrequency * row / rows + columnFrequency * column / columns);

					realSum += (real[position] ?? 0) * Math.cos(angle) - (imaginary[position] ?? 0) * Math.sin(angle);
				}
			}

			output[row * columns + column] = realSum / (rows * columns);
		}
	}

	return output;
}

function directDftt(
	nlmSmoothed: Float32Array,
	rawMask: Float32Array,
	numFrames: number,
	numBins: number,
	params: DfttParams,
): { readonly output: Float32Array; readonly maxInverseTimeImaginary: number } {
	const frequencyWindow = nonperiodicHann(params.blockFreq);
	const timeWindow = nonperiodicHann(params.blockTime);
	const accumulator = new Float64Array(rawMask.length);
	const windowSumSquared = new Float64Array(rawMask.length);
	let maxInverseTimeImaginary = 0;

	for (let frameStart = 0; frameStart < numFrames; frameStart += params.hopTime) {
		for (let binStart = 0; binStart < numBins; binStart += params.hopFreq) {
			const rawBlock = new Float64Array(params.blockTime * params.blockFreq);
			const nlmBlock = new Float64Array(rawBlock.length);

			for (let time = 0; time < params.blockTime; time++) {
				for (let frequency = 0; frequency < params.blockFreq; frequency++) {
					const sourceFrame = Math.min(frameStart + time, numFrames - 1);
					const sourceBin = Math.min(binStart + frequency, numBins - 1);
					const sourcePosition = sourceFrame * numBins + sourceBin;
					const blockPosition = time * params.blockFreq + frequency;
					const windowValue = (timeWindow[time] ?? 0) * (frequencyWindow[frequency] ?? 0);

					rawBlock[blockPosition] = (rawMask[sourcePosition] ?? 0) * windowValue;
					nlmBlock[blockPosition] = (nlmSmoothed[sourcePosition] ?? 0) * windowValue;
				}
			}

			const rawTransform = directDft2D(rawBlock, params.blockTime, params.blockFreq);
			const nlmTransform = directDft2D(nlmBlock, params.blockTime, params.blockFreq);
			const gainedReal = new Float64Array(rawBlock.length);
			const gainedImaginary = new Float64Array(rawBlock.length);
			const thresholdSquared = params.threshold * params.threshold;

			for (let index = 0; index < gainedReal.length; index++) {
				const nlmMagnitudeSquared = (nlmTransform.re[index] ?? 0) ** 2 + (nlmTransform.im[index] ?? 0) ** 2;
				const gain = thresholdSquared === 0 ? nlmMagnitudeSquared === 0 ? 0 : 1 : nlmMagnitudeSquared / (nlmMagnitudeSquared + thresholdSquared);

				gainedReal[index] = (rawTransform.re[index] ?? 0) * gain;
				gainedImaginary[index] = (rawTransform.im[index] ?? 0) * gain;
			}

			const inverseTimeReal = new Float64Array(rawBlock.length);
			const inverseTimeImaginary = new Float64Array(rawBlock.length);

			for (let time = 0; time < params.blockTime; time++) {
				for (let frequency = 0; frequency < params.blockFreq; frequency++) {
					let realSum = 0;
					let imaginarySum = 0;

					for (let timeFrequency = 0; timeFrequency < params.blockTime; timeFrequency++) {
						const transformPosition = timeFrequency * params.blockFreq + frequency;
						const angle = 2 * Math.PI * timeFrequency * time / params.blockTime;
						const transformReal = gainedReal[transformPosition] ?? 0;
						const transformImaginary = gainedImaginary[transformPosition] ?? 0;

						realSum += transformReal * Math.cos(angle) - transformImaginary * Math.sin(angle);
						imaginarySum += transformReal * Math.sin(angle) + transformImaginary * Math.cos(angle);
					}

					const inversePosition = time * params.blockFreq + frequency;

					inverseTimeReal[inversePosition] = realSum / params.blockTime;
					inverseTimeImaginary[inversePosition] = imaginarySum / params.blockTime;
					maxInverseTimeImaginary = Math.max(maxInverseTimeImaginary, Math.abs(inverseTimeImaginary[inversePosition] ?? 0));
				}
			}

			const synthesized = new Float64Array(rawBlock.length);

			for (let time = 0; time < params.blockTime; time++) {
				for (let frequency = 0; frequency < params.blockFreq; frequency++) {
					let realSum = 0;

					for (let frequencyIndex = 0; frequencyIndex < params.blockFreq; frequencyIndex++) {
						const inversePosition = time * params.blockFreq + frequencyIndex;
						const angle = 2 * Math.PI * frequencyIndex * frequency / params.blockFreq;

						realSum += (inverseTimeReal[inversePosition] ?? 0) * Math.cos(angle) - (inverseTimeImaginary[inversePosition] ?? 0) * Math.sin(angle);
					}

					synthesized[time * params.blockFreq + frequency] = realSum / params.blockFreq;
				}
			}

			for (let time = 0; time < params.blockTime && frameStart + time < numFrames; time++) {
				for (let frequency = 0; frequency < params.blockFreq && binStart + frequency < numBins; frequency++) {
					const destination = (frameStart + time) * numBins + binStart + frequency;
					const blockPosition = time * params.blockFreq + frequency;
					const windowValue = (timeWindow[time] ?? 0) * (frequencyWindow[frequency] ?? 0);

					accumulator[destination] = (accumulator[destination] ?? 0) + (synthesized[blockPosition] ?? 0) * windowValue;
					windowSumSquared[destination] = (windowSumSquared[destination] ?? 0) + windowValue * windowValue;
				}
			}
		}
	}

	const output = new Float32Array(rawMask.length);

	for (let index = 0; index < output.length; index++) {
		const windowWeight = windowSumSquared[index] ?? 0;
		const value = windowWeight > 1e-8 ? (accumulator[index] ?? 0) / windowWeight : rawMask[index] ?? 0;

		output[index] = Math.max(0, Math.min(value, 1));
	}

	return { output, maxInverseTimeImaginary };
}

function createFakeAddon(calls: Array<AddonCall>): FakeAddon {
	return {
		batchFft2D(input, rows, columns, batchCount) {
			const complexColumns = Math.floor(columns / 2) + 1;
			const outputLength = batchCount * rows * complexColumns;
			const real = new Float32Array(outputLength);
			const imaginary = new Float32Array(outputLength);

			calls.push({ kind: "forward", batchCount, inputLength: input.length, outputLength });

			for (let block = 0; block < batchCount; block++) {
				const blockStart = block * rows * columns;
				const transform = directDft2D(input.subarray(blockStart, blockStart + rows * columns), rows, columns);

				for (let rowFrequency = 0; rowFrequency < rows; rowFrequency++) {
					for (let columnFrequency = 0; columnFrequency < complexColumns; columnFrequency++) {
						const source = rowFrequency * columns + columnFrequency;
						const destination = block * rows * complexColumns + rowFrequency * complexColumns + columnFrequency;

						real[destination] = transform.re[source] ?? 0;
						imaginary[destination] = transform.im[source] ?? 0;
					}
				}
			}

			return { re: real, im: imaginary };
		},
		batchIfft2D(real, imaginary, rows, columns, batchCount) {
			const complexColumns = Math.floor(columns / 2) + 1;
			const output = new Float32Array(batchCount * rows * columns);

			calls.push({ kind: "inverse", batchCount, inputLength: real.length + imaginary.length, outputLength: output.length });

			for (let block = 0; block < batchCount; block++) {
				const fullReal = new Float64Array(rows * columns);
				const fullImaginary = new Float64Array(rows * columns);

				for (let rowFrequency = 0; rowFrequency < rows; rowFrequency++) {
					for (let columnFrequency = 0; columnFrequency < columns; columnFrequency++) {
						const destination = rowFrequency * columns + columnFrequency;
						const mirrored = columnFrequency >= complexColumns;
						const sourceRow = mirrored ? (rows - rowFrequency) % rows : rowFrequency;
						const sourceColumn = mirrored ? columns - columnFrequency : columnFrequency;
						const source = block * rows * complexColumns + sourceRow * complexColumns + sourceColumn;

						fullReal[destination] = real[source] ?? 0;
						fullImaginary[destination] = mirrored ? -(imaginary[source] ?? 0) : imaginary[source] ?? 0;
					}
				}

				const synthesized = directIdft2D(fullReal, fullImaginary, rows, columns);

				output.set(synthesized, block * rows * columns);
			}

			return output;
		},
	};
}

function maximumError(actual: Float32Array, expected: Float32Array): number {
	let maximum = 0;

	for (let index = 0; index < actual.length; index++) {
		maximum = Math.max(maximum, Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)));
	}

	return maximum;
}

function runDftt(
	nlm: Float32Array,
	raw: Float32Array,
	numFrames: number,
	numBins: number,
	params: DfttParams,
	backend?: "fftw",
	maxBatchBytes?: number,
	initialOutput = -3,
	profile?: DfttProfileMs,
): Float32Array {
	const output = new Float32Array(raw.length).fill(initialOutput);

	applyDfttSmoothing(nlm, raw, numFrames, numBins, params, output, backend, undefined, profile, { maxBatchBytes });

	return output;
}

describe("applyDfttSmoothing", () => {
	beforeEach(() => {
		backendState.addon = undefined;
	});

	it("matches an independent direct 2D DFT oracle with a complex inverse-time intermediate", () => {
		const numFrames = 5;
		const numBins = 6;
		const raw = Float32Array.from({ length: numFrames * numBins }, (_, index) => ((index * 19 + index % 4 * 7) % 97) / 96);
		const nlm = Float32Array.from({ length: raw.length }, (_, index) => ((index * 11 + 5) % 53) / 52);
		const expected = directDftt(nlm, raw, numFrames, numBins, defaultParams);
		const output = runDftt(nlm, raw, numFrames, numBins, defaultParams, undefined, undefined, 8);

		expect(expected.maxInverseTimeImaginary).toBeGreaterThan(1e-4);
		expect(maximumError(output, expected.output)).toBeLessThan(1e-5);
	});

	it("uses exact byte-derived one-block, two-block, odd-final, and large-batch paths", () => {
		const numFrames = 2;
		const numBins = 5;
		const params = { ...defaultParams, blockFreq: 2, blockTime: 2, hopFreq: 2, hopTime: 2 };
		const blockSize = params.blockFreq * params.blockTime;
		const complexBlockSize = params.blockTime * (Math.floor(params.blockFreq / 2) + 1);
		const bytesPerBlock = 4 * (3 * blockSize + 4 * complexBlockSize);
		const raw = Float32Array.from({ length: numFrames * numBins }, (_, index) => (index + 1) / 12);
		const nlm = Float32Array.from({ length: raw.length }, (_, index) => (raw.length - index) / 13);
		const outputs: Array<Float32Array> = [];

		for (const budget of [bytesPerBlock, 2 * bytesPerBlock, 32 * 1024 * 1024]) {
			const calls: Array<AddonCall> = [];

			backendState.addon = createFakeAddon(calls);
			outputs.push(runDftt(nlm, raw, numFrames, numBins, params, "fftw", budget));

			const capacity = getDfttBatchBlockCount(blockSize, complexBlockSize, budget);

			for (const call of calls) expect(call.batchCount).toBeLessThanOrEqual(capacity);
			if (budget === bytesPerBlock) expect(calls.filter((call) => call.kind === "inverse").map((call) => call.batchCount)).toEqual([1, 1, 1]);
			if (budget === 2 * bytesPerBlock) expect(calls.filter((call) => call.kind === "inverse").map((call) => call.batchCount)).toEqual([2, 1]);
			if (budget === 32 * 1024 * 1024) expect(calls.filter((call) => call.kind === "inverse").map((call) => call.batchCount)).toEqual([3]);
		}

		expect(outputs[0]).toEqual(outputs[1]);
		expect(outputs[1]).toEqual(outputs[2]);

		const jsOutput = runDftt(nlm, raw, numFrames, numBins, params);

		expect(maximumError(outputs[2] ?? new Float32Array(0), jsOutput)).toBeLessThan(1e-5);
	});

	it("is independent of prefilled output and accumulates profile batches with one normalization", () => {
		const params = { ...defaultParams, blockFreq: 2, blockTime: 2, hopFreq: 2, hopTime: 2 };
		const raw = Float32Array.from({ length: 10 }, (_, index) => (index + 1) / 12);
		const nlm = Float32Array.from({ length: raw.length }, (_, index) => (index + 2) / 14);
		const blockSize = 4;
		const complexBlockSize = 4;
		const bytesPerBlock = 4 * (3 * blockSize + 4 * complexBlockSize);
		const profile: DfttProfileMs = { fill: 0, forward: 0, gain: 0, inverse: 0, ola: 0, normalize: 0 };
		let tick = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => tick++);

		backendState.addon = createFakeAddon([]);

		const first = runDftt(nlm, raw, 2, 5, params, "fftw", 2 * bytesPerBlock, -9, profile);
		const second = runDftt(nlm, raw, 2, 5, params, "fftw", 2 * bytesPerBlock, 9);

		now.mockRestore();
		expect(first).toEqual(second);
		expect(profile).toEqual({ fill: 2, forward: 2, gain: 2, inverse: 2, ola: 2, normalize: 1 });
	});

	it("supports one-sample block dimensions with one complex bin per block", () => {
		const calls: Array<AddonCall> = [];
		const params: DfttParams = { blockFreq: 1, blockTime: 1, hopFreq: 1, hopTime: 1, threshold: 0.2 };
		const raw = Float32Array.from([0.1, 0.3, 0.5, 0.7, 0.9, 1]);
		const nlm = Float32Array.from([0.2, 0.4, 0.6, 0.8, 0.5, 0.25]);

		backendState.addon = createFakeAddon(calls);

		const output = runDftt(nlm, raw, 2, 3, params, "fftw");
		const forwardCalls = calls.filter((call) => call.kind === "forward");
		const inverseCalls = calls.filter((call) => call.kind === "inverse");

		expect(output).toHaveLength(6);
		expect(forwardCalls).toHaveLength(2);
		expect(forwardCalls[0]).toEqual({ kind: "forward", batchCount: 6, inputLength: 6, outputLength: 6 });
		expect(inverseCalls).toEqual([{ kind: "inverse", batchCount: 6, inputLength: 12, outputLength: 6 }]);
	});

	it("uses the finite zero-noise Wiener limit when a positive threshold square underflows", () => {
		const params: DfttParams = { blockFreq: 1, blockTime: 1, hopFreq: 1, hopTime: 1, threshold: Number.MIN_VALUE };
		const raw = Float32Array.from([0.25, 0.75, 1]);
		const nlm = new Float32Array(raw.length);
		const expected = directDftt(nlm, raw, 1, 3, params).output;
		const jsOutput = runDftt(nlm, raw, 1, 3, params);
		const calls: Array<AddonCall> = [];

		backendState.addon = createFakeAddon(calls);

		const addonOutput = runDftt(nlm, raw, 1, 3, params, "fftw");

		expect(expected).toEqual(new Float32Array(3));
		expect(jsOutput).toEqual(expected);
		expect(addonOutput).toEqual(expected);
		expect(calls.filter((call) => call.kind === "inverse")).toHaveLength(1);

		for (const output of [jsOutput, addonOutput]) {
			for (const value of output) {
				expect(Number.isFinite(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(1);
			}
		}
	});

	it("copies raw Float32 bits exactly at zero threshold before backend selection", () => {
		const raw = new Float32Array(4);
		const rawBits = new Uint32Array(raw.buffer);

		rawBits.set([0x80000000, 0x3f800001, 0x7fc00001, 0x7f7fffff]);
		backendState.addon = {
			batchFft2D: () => {
				throw new Error("must not run");
			},
			batchIfft2D: () => {
				throw new Error("must not run");
			},
		};

		const output = new Float32Array(4).fill(9);

		applyDfttSmoothing(new Float32Array(4), raw, 2, 2, { ...defaultParams, threshold: 0 }, output, "fftw", undefined);

		expect(Array.from(new Uint32Array(output.buffer))).toEqual(Array.from(rawBits));
		expect(() => applyDfttSmoothing(new Float32Array(4), raw, 2, 2, { ...defaultParams, threshold: 0 }, raw, "fftw", undefined)).not.toThrow();
	});

	it.each([undefined, "fftw" as const])("rejects overlapping output on the %s backend", (backend) => {
		const storage = new Float32Array(10);
		const nlm = storage.subarray(0, 4);
		const raw = new Float32Array(4).fill(0.5);
		const output = storage.subarray(2, 6);

		if (backend) backendState.addon = createFakeAddon([]);

		expect(() => applyDfttSmoothing(nlm, raw, 2, 2, { ...defaultParams, blockFreq: 2, blockTime: 2 }, output, backend, undefined)).toThrow("must not overlap");
		expect(() => applyDfttSmoothing(new Float32Array(4), raw, 2, 2, { ...defaultParams, blockFreq: 2, blockTime: 2 }, raw, backend, undefined)).toThrow("must not overlap");
	});

	it.each([
		["zero frames", 0, 2, defaultParams, undefined],
		["fractional bins", 2, 2.5, defaultParams, undefined],
		["non-power-of-two frequency block", 2, 2, { ...defaultParams, blockFreq: 3 }, undefined],
		["zero time block", 2, 2, { ...defaultParams, blockTime: 0 }, undefined],
		["zero frequency hop", 2, 2, { ...defaultParams, hopFreq: 0 }, undefined],
		["oversized time hop", 2, 2, { ...defaultParams, hopTime: 8 }, undefined],
		["negative threshold", 2, 2, { ...defaultParams, threshold: -1 }, undefined],
		["non-finite threshold", 2, 2, { ...defaultParams, threshold: Number.NaN }, undefined],
		["zero budget", 2, 2, defaultParams, 0],
		["non-finite budget", 2, 2, defaultParams, Number.POSITIVE_INFINITY],
		["budget above 32 MiB", 2, 2, defaultParams, 32 * 1024 * 1024 + 1],
	] as const)("rejects %s", (_name, numFrames, numBins, params, maxBatchBytes) => {
		const length = Number.isSafeInteger(numFrames * numBins) && numFrames * numBins > 0 ? numFrames * numBins : 0;

		expect(() => applyDfttSmoothing(
			new Float32Array(length),
			new Float32Array(length),
			numFrames,
			numBins,
			params,
			new Float32Array(length),
			undefined,
			undefined,
			undefined,
			{ maxBatchBytes },
		)).toThrow();
	});

	it("requires exact input and output lengths", () => {
		expect(() => applyDfttSmoothing(new Float32Array(3), new Float32Array(4), 2, 2, { ...defaultParams, blockFreq: 2, blockTime: 2 }, new Float32Array(4), undefined, undefined)).toThrow("lengths must equal 4");
		expect(() => applyDfttSmoothing(new Float32Array(4), new Float32Array(4), 2, 2, { ...defaultParams, blockFreq: 2, blockTime: 2 }, new Float32Array(5), undefined, undefined)).toThrow("lengths must equal 4");
	});

	it("derives the batch count from all seven temporary arrays and rejects an undersized budget", () => {
		const blockSize = 8;
		const complexBlockSize = 6;
		const bytesPerBlock = 4 * (3 * blockSize + 4 * complexBlockSize);

		expect(getDfttBatchBlockCount(blockSize, complexBlockSize, bytesPerBlock * 3 + bytesPerBlock - 1)).toBe(3);
		expect(() => getDfttBatchBlockCount(blockSize, complexBlockSize, bytesPerBlock - 1)).toThrow("One DFTT block requires");
	});
});
