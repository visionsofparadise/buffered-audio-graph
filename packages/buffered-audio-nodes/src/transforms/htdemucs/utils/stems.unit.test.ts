import { describe, it, expect } from "vitest";
import { mixStemsToStereo } from "./stems";

// Builds the 8 interleaved stem accumulators (L/R per stem), zero except the ones supplied.
function makeStemAccum(nStable: number, overrides: Record<number, Array<number>>): Array<Float32Array> {
	const accum: Array<Float32Array> = [];

	for (let slot = 0; slot < 8; slot++) {
		accum.push(Float32Array.from(overrides[slot] ?? new Array<number>(nStable).fill(0)));
	}

	return accum;
}

describe("mixStemsToStereo", () => {
	// Happy path: one stem at unit gain, unit OLA weight, identity stats → passthrough of that stem.
	it("passes a single unit-gain stem through with identity stats", () => {
		const accum = makeStemAccum(2, { 0: [0.5, 0.6], 1: [0.3, 0.4] });
		const { outLeft, outRight } = mixStemsToStereo(accum, Float32Array.from([1, 1]), [1, 0, 0, 0], { mean: 0, std: 1 }, 2);

		expect(outLeft[0]).toBeCloseTo(0.5, 6);
		expect(outLeft[1]).toBeCloseTo(0.6, 6);
		expect(outRight[0]).toBeCloseTo(0.3, 6);
		expect(outRight[1]).toBeCloseTo(0.4, 6);
	});

	// OLA normalization divides by sumWeight; de-normalization applies std/mean.
	it("normalizes by sumWeight then de-normalizes with std and mean", () => {
		const accum = makeStemAccum(1, { 0: [4] });
		const { outLeft } = mixStemsToStereo(accum, Float32Array.from([2]), [1, 0, 0, 0], { mean: 0.1, std: 2 }, 1);

		// (4 / 2) * gain 1 = 2; 2 * std 2 + mean 0.1 = 4.1
		expect(outLeft[0]).toBeCloseTo(4.1, 5);
	});

	// Summation across stems with their gains.
	it("sums enabled stems weighted by gain", () => {
		const accum = makeStemAccum(1, { 0: [1], 2: [2] }); // stem0 L slot 0, stem1 L slot 2
		const { outLeft } = mixStemsToStereo(accum, Float32Array.from([1]), [3, 5, 0, 0], { mean: 0, std: 1 }, 1);

		// 1*3 + 2*5 = 13
		expect(outLeft[0]).toBeCloseTo(13, 5);
	});

	// Boundary: sumWeight 0 contributes zero (no divide-by-zero); only mean remains.
	it("treats a zero OLA weight as a zero contribution", () => {
		const accum = makeStemAccum(1, { 0: [9] });
		const { outLeft } = mixStemsToStereo(accum, Float32Array.from([0]), [1, 0, 0, 0], { mean: 0.25, std: 1 }, 1);

		expect(outLeft[0]).toBeCloseTo(0.25, 6);
	});

	// A gain-0 stem is skipped entirely; all-zero gains leave only the mean.
	it("skips gain-0 stems", () => {
		const accum = makeStemAccum(1, { 0: [1] });
		const { outLeft } = mixStemsToStereo(accum, Float32Array.from([1]), [0, 0, 0, 0], { mean: -0.5, std: 3 }, 1);

		expect(outLeft[0]).toBeCloseTo(-0.5, 6);
	});
});
