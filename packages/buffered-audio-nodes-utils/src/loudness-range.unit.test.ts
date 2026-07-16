import { describe, expect, it } from "vitest";
import { computeLoudnessRange, getLraConsideredMinLufs, getLraConsideredStats } from "./loudness-range";

describe("computeLoudnessRange", () => {
	it("returns zero for empty and one-value inputs", () => {
		expect(computeLoudnessRange([])).toBe(0);
		expect(computeLoudnessRange([-30])).toBe(0);
	});

	it("includes the -70 LUFS absolute-gate boundary", () => {
		expect(computeLoudnessRange([-70, -60])).toBe(10);
	});

	it("includes the relative-gate boundary", () => {
		const boundary = -50;
		const high = boundary + 10 * Math.log10(199);

		expect(computeLoudnessRange([boundary, high])).toBeCloseTo(high - boundary, 12);
	});

	it("uses rounded zero-based 10th and 95th percentile indices", () => {
		expect(computeLoudnessRange([-30, -29, -28, -27, -26, -25])).toBe(4);
	});
});

describe("getLraConsideredStats", () => {
	it("returns infinite anchors when no value survives the absolute gate", () => {
		expect(getLraConsideredStats([])).toEqual({ min: Number.POSITIVE_INFINITY, median: Number.POSITIVE_INFINITY });
		expect(getLraConsideredStats([-80, -71])).toEqual({ min: Number.POSITIVE_INFINITY, median: Number.POSITIVE_INFINITY });
	});

	it("returns the project-local minimum and median of the gated set", () => {
		expect(getLraConsideredStats([-30, -29, -28, -27])).toEqual({ min: -30, median: -28.5 });
		expect(getLraConsideredMinLufs([-30, -29, -28, -27])).toBe(-30);
	});
});
