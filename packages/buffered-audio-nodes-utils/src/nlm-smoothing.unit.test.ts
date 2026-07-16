import { describe, expect, it } from "vitest";
import { applyNlmSmoothing, applyNlmSmoothingRange, type NlmParams } from "./nlm-smoothing";

const defaultParams: NlmParams = {
	patchSize: 4,
	searchFreqRadius: 2,
	searchTimePre: 2,
	searchTimePost: 1,
	pasteBlockSize: 3,
	threshold: 0.7,
};

function clamp(value: number, maximum: number): number {
	return Math.max(0, Math.min(value, maximum));
}

function scalarNlm(mask: Float32Array, numFrames: number, numBins: number, params: NlmParams): Float32Array {
	if (params.threshold === 0) return Float32Array.from(mask);

	const output = new Float32Array(mask.length);
	const halfPatch = params.patchSize / 2;
	const thresholdSquared = params.threshold * params.threshold;

	for (let blockFrame = 0; blockFrame < numFrames; blockFrame += params.pasteBlockSize) {
		for (let blockBin = 0; blockBin < numBins; blockBin += params.pasteBlockSize) {
			const centreFrame = blockFrame + Math.floor(params.pasteBlockSize / 2);
			const centreBin = blockBin + Math.floor(params.pasteBlockSize / 2);
			let valueSum = 0;
			let weightSum = 0;

			for (let candidateFrame = centreFrame - params.searchTimePre; candidateFrame <= centreFrame + params.searchTimePost; candidateFrame++) {
				for (let candidateBin = centreBin - params.searchFreqRadius; candidateBin <= centreBin + params.searchFreqRadius; candidateBin++) {
					const clampedCandidateFrame = clamp(candidateFrame, numFrames - 1);
					const clampedCandidateBin = clamp(candidateBin, numBins - 1);
					let distanceSquared = 0;

					for (let patchFrame = -halfPatch; patchFrame < halfPatch; patchFrame++) {
						for (let patchBin = -halfPatch; patchBin < halfPatch; patchBin++) {
							const centrePosition = clamp(centreFrame + patchFrame, numFrames - 1) * numBins + clamp(centreBin + patchBin, numBins - 1);
							const candidatePosition = clamp(clampedCandidateFrame + patchFrame, numFrames - 1) * numBins + clamp(clampedCandidateBin + patchBin, numBins - 1);
							const difference = (mask[centrePosition] ?? 0) - (mask[candidatePosition] ?? 0);

							distanceSquared += difference * difference;
						}
					}

					const weight = Math.exp(-distanceSquared / thresholdSquared);

					weightSum += weight;
					valueSum += weight * (mask[clampedCandidateFrame * numBins + clampedCandidateBin] ?? 0);
				}
			}

			const smoothed = valueSum / weightSum;
			const clampedSmoothed = Math.max(0, Math.min(smoothed, 1));

			for (let pasteFrame = 0; pasteFrame < params.pasteBlockSize && blockFrame + pasteFrame < numFrames; pasteFrame++) {
				for (let pasteBin = 0; pasteBin < params.pasteBlockSize && blockBin + pasteBin < numBins; pasteBin++) {
					output[(blockFrame + pasteFrame) * numBins + blockBin + pasteBin] = clampedSmoothed;
				}
			}
		}
	}

	return output;
}

function maximumError(actual: Float32Array, expected: Float32Array): number {
	let maximum = 0;

	for (let index = 0; index < actual.length; index++) {
		maximum = Math.max(maximum, Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)));
	}

	return maximum;
}

describe("applyNlmSmoothing", () => {
	it("matches an independent scalar NLM on an asymmetric mask", () => {
		const numFrames = 5;
		const numBins = 7;
		const mask = Float32Array.from({ length: numFrames * numBins }, (_, index) => ((index * 17 + index % 5 * 11) % 101) / 100);
		const output = new Float32Array(mask.length);
		const expected = scalarNlm(mask, numFrames, numBins, defaultParams);

		applyNlmSmoothing(mask, numFrames, numBins, defaultParams, output);

		expect(maximumError(output, expected)).toBeLessThanOrEqual(1e-6);
		expect(output[0]).toBe(expected[0]);
		expect(output[numBins - 1]).toBe(expected[numBins - 1]);
		expect(output[(numFrames - 1) * numBins]).toBe(expected[(numFrames - 1) * numBins]);
		expect(output[output.length - 1]).toBe(expected[expected.length - 1]);
	});

	it("preserves a constant mask at every boundary", () => {
		const mask = new Float32Array(15).fill(0.375);
		const output = new Float32Array(mask.length);

		applyNlmSmoothing(mask, 3, 5, { ...defaultParams, pasteBlockSize: 4 }, output);

		for (const value of output) expect(value).toBe(0.375);
	});

	it("produces the exact full result from disjoint aligned ranges", () => {
		const numFrames = 5;
		const numBins = 6;
		const params = { ...defaultParams, pasteBlockSize: 2 };
		const mask = Float32Array.from({ length: numFrames * numBins }, (_, index) => (index * 13 % 29) / 28);
		const full = new Float32Array(mask.length);
		const ranged = new Float32Array(mask.length).fill(-1);

		applyNlmSmoothing(mask, numFrames, numBins, params, full);
		applyNlmSmoothingRange(mask, numFrames, numBins, params, ranged, 0, 2);
		applyNlmSmoothingRange(mask, numFrames, numBins, params, ranged, 2, 4);
		applyNlmSmoothingRange(mask, numFrames, numBins, params, ranged, 4, 5);

		expect(ranged).toEqual(full);
	});

	it("clamps gain-mask output and writes only its owned paste rows", () => {
		const mask = Float32Array.from({ length: 24 }, (_, index) => index % 2 === 0 ? -2 : 2);
		const output = new Float32Array(mask.length).fill(-7);
		const params = { ...defaultParams, patchSize: 2, searchFreqRadius: 0, searchTimePre: 0, searchTimePost: 0, pasteBlockSize: 2 };

		applyNlmSmoothingRange(mask, 6, 4, params, output, 2, 4);

		for (let frame = 0; frame < 6; frame++) {
			for (let bin = 0; bin < 4; bin++) {
				const value = output[frame * 4 + bin] ?? Number.NaN;

				if (frame >= 2 && frame < 4) expect(value).toBeGreaterThanOrEqual(0);
				else expect(value).toBe(-7);
				if (frame >= 2 && frame < 4) expect(value).toBeLessThanOrEqual(1);
			}
		}
	});

	it("copies every raw Float32 bit exactly when threshold is zero", () => {
		const mask = new Float32Array(4);
		const maskBits = new Uint32Array(mask.buffer);

		maskBits.set([0x80000000, 0x3f800001, 0x7fc00001, 0x7f7fffff]);

		const output = new Float32Array(mask.length).fill(9);

		applyNlmSmoothing(mask, 2, 2, { ...defaultParams, threshold: 0 }, output);

		expect(Array.from(new Uint32Array(output.buffer))).toEqual(Array.from(maskBits));
	});

	it("keeps zero-threshold range writes inside their owned rows", () => {
		const mask = Float32Array.from({ length: 24 }, (_, index) => index / 24);
		const output = new Float32Array(mask.length).fill(-1);
		const params = { ...defaultParams, pasteBlockSize: 2, threshold: 0 };

		applyNlmSmoothingRange(mask, 6, 4, params, output, 2, 4);

		expect(Array.from(output.subarray(0, 8))).toEqual(new Array<number>(8).fill(-1));
		expect(output.subarray(8, 16)).toEqual(mask.subarray(8, 16));
		expect(Array.from(output.subarray(16))).toEqual(new Array<number>(8).fill(-1));
	});

	it("accepts empty mask geometry", () => {
		expect(() => applyNlmSmoothing(new Float32Array(0), 0, 0, defaultParams, new Float32Array(0))).not.toThrow();
	});

	it.each([
		["negative dimensions", -1, 4, defaultParams, 0, 0],
		["fractional dimensions", 4.5, 4, defaultParams, 0, 0],
		["odd patch", 4, 4, { ...defaultParams, patchSize: 3 }, 0, 4],
		["zero patch", 4, 4, { ...defaultParams, patchSize: 0 }, 0, 4],
		["negative search", 4, 4, { ...defaultParams, searchTimePre: -1 }, 0, 4],
		["fractional search", 4, 4, { ...defaultParams, searchFreqRadius: 1.5 }, 0, 4],
		["zero paste", 4, 4, { ...defaultParams, pasteBlockSize: 0 }, 0, 4],
		["negative threshold", 4, 4, { ...defaultParams, threshold: -1 }, 0, 4],
		["non-finite threshold", 4, 4, { ...defaultParams, threshold: Number.POSITIVE_INFINITY }, 0, 4],
		["misaligned start", 4, 4, { ...defaultParams, pasteBlockSize: 2 }, 1, 4],
		["misaligned end", 5, 4, { ...defaultParams, pasteBlockSize: 2 }, 0, 3],
		["reversed range", 4, 4, { ...defaultParams, pasteBlockSize: 2 }, 4, 2],
		["out-of-range end", 4, 4, { ...defaultParams, pasteBlockSize: 2 }, 0, 6],
	] as const)("rejects %s", (_name, numFrames, numBins, params, start, end) => {
		const length = Number.isSafeInteger(numFrames * numBins) && numFrames * numBins >= 0 ? numFrames * numBins : 0;
		const mask = new Float32Array(length);
		const output = new Float32Array(length);

		expect(() => applyNlmSmoothingRange(mask, numFrames, numBins, params, output, start, end)).toThrow();
	});

	it("rejects masks and outputs whose lengths do not exactly match the geometry", () => {
		expect(() => applyNlmSmoothing(new Float32Array(15), 4, 4, defaultParams, new Float32Array(16))).toThrow("lengths must equal 16");
		expect(() => applyNlmSmoothing(new Float32Array(16), 4, 4, defaultParams, new Float32Array(17))).toThrow("lengths must equal 16");
	});
});
