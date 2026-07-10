import { describe, expect, it } from "vitest";
import { computeTrimRegion, findFirstAbove, findLastAbove } from "./silence";

describe("findFirstAbove", () => {
	it("returns the first index whose absolute value exceeds the threshold", () => {
		const channel = new Float32Array([0, 0.005, 0.02, 0]);

		expect(findFirstAbove([channel], 4, 0.01)).toBe(2);
	});

	it("scans all channels at each frame", () => {
		const left = new Float32Array([0, 0, 0.5]);
		const right = new Float32Array([0, 0.5, 0]);

		expect(findFirstAbove([left, right], 3, 0.01)).toBe(1);
	});

	it("returns the frame count when nothing exceeds the threshold", () => {
		expect(findFirstAbove([new Float32Array([0, 0.001])], 2, 0.01)).toBe(2);
	});

	it("uses strict comparison (equal-to-threshold is not above)", () => {
		expect(findFirstAbove([new Float32Array([0.01, 0.01])], 2, 0.01)).toBe(2);
	});
});

describe("findLastAbove", () => {
	it("returns the last index whose absolute value exceeds the threshold", () => {
		const channel = new Float32Array([0.02, 0.5, 0.005, 0]);

		expect(findLastAbove([channel], 4, 0.01)).toBe(1);
	});

	it("returns 0 when nothing exceeds the threshold", () => {
		expect(findLastAbove([new Float32Array([0, 0])], 2, 0.01)).toBe(0);
	});
});

describe("computeTrimRegion", () => {
	it("keeps the signal region plus margins on both sides", () => {
		expect(computeTrimRegion(100, 500, 1000, 10, true, true)).toEqual({ startFrame: 90, endFrame: 511 });
	});

	it("clamps the leading margin at frame 0", () => {
		expect(computeTrimRegion(5, 500, 1000, 10, true, true)).toEqual({ startFrame: 0, endFrame: 511 });
	});

	it("clamps the trailing margin at the frame count", () => {
		expect(computeTrimRegion(100, 995, 1000, 10, true, true)).toEqual({ startFrame: 90, endFrame: 1000 });
	});

	it("keeps the full start/end when a side is disabled", () => {
		expect(computeTrimRegion(100, 500, 1000, 10, false, true)).toEqual({ startFrame: 0, endFrame: 511 });
		expect(computeTrimRegion(100, 500, 1000, 10, true, false)).toEqual({ startFrame: 90, endFrame: 1000 });
	});

	it("returns undefined when nothing was above threshold", () => {
		expect(computeTrimRegion(1000, 0, 1000, 10, true, true)).toBeUndefined();
	});
});
