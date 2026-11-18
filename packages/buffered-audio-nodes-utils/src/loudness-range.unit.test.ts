import { describe, expect, it } from "vitest";
import { computeLoudnessRange } from "./loudness-range";

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
