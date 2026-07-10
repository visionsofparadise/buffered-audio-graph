import { describe, it, expect } from "vitest";
import { amplitudePercentile, computeTotalSamples } from "./stats";

describe("computeTotalSamples", () => {
	it("sums the bucket counts", () => {
		expect(computeTotalSamples(Uint32Array.from([1, 2, 3]))).toBe(6);
	});

	it("returns 0 for an empty histogram", () => {
		expect(computeTotalSamples(new Uint32Array(0))).toBe(0);
	});
});

describe("amplitudePercentile", () => {
	// Uniform histogram: 4 buckets × 10 counts across [0, 1].
	const uniform = Uint32Array.from([10, 10, 10, 10]);

	it("interpolates the median to the midpoint", () => {
		expect(amplitudePercentile(uniform, 1, 40, 50)).toBeCloseTo(0.5, 6);
	});

	it("returns 0 at the 0th percentile", () => {
		expect(amplitudePercentile(uniform, 1, 40, 0)).toBe(0);
	});

	it("returns bucketMax at the 100th percentile", () => {
		expect(amplitudePercentile(uniform, 1, 40, 100)).toBeCloseTo(1, 6);
	});

	// Boundary: empty distribution or zero range yields 0, no divide-by-zero.
	it("returns 0 for an empty distribution", () => {
		expect(amplitudePercentile(uniform, 1, 0, 50)).toBe(0);
		expect(amplitudePercentile(uniform, 0, 40, 50)).toBe(0);
	});

	// A zero-count bucket in the walk contributes no width; interpolation resumes at the next populated bucket.
	it("skips empty buckets in the cumulative walk", () => {
		const gapped = Uint32Array.from([10, 0, 10]);

		expect(amplitudePercentile(gapped, 1, 20, 50)).toBeCloseTo(1 / 3, 6);
	});

	// A target past the final bucket clamps to bucketMax.
	it("clamps past-end percentiles to bucketMax", () => {
		expect(amplitudePercentile(uniform, 1, 40, 101)).toBeCloseTo(1, 6);
	});
});
