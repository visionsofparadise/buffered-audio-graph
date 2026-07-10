import { describe, expect, it } from "vitest";
import { findPeak, resolveScale } from "./peak";

describe("findPeak", () => {
	it("returns the largest absolute sample across channels", () => {
		const left = new Float32Array([0.1, -0.8, 0.3]);
		const right = new Float32Array([0.2, 0.5, -0.4]);

		expect(findPeak([left, right])).toBeCloseTo(0.8, 6);
	});

	it("returns 0 for all-silent input", () => {
		expect(findPeak([new Float32Array(10)])).toBe(0);
	});

	it("returns 0 for empty channel list", () => {
		expect(findPeak([])).toBe(0);
	});

	it("ignores non-finite samples", () => {
		const channel = new Float32Array([0.5, Infinity, NaN, -0.6]);

		expect(findPeak([channel])).toBeCloseTo(0.6, 6);
	});
});

describe("resolveScale", () => {
	it("scales the peak to the ceiling", () => {
		expect(resolveScale(0.5, 1)).toBe(2);
	});

	it("returns 1 when the peak is 0 (silence)", () => {
		expect(resolveScale(0, 0.9)).toBe(1);
	});

	it("returns 1 when the ratio is non-finite", () => {
		expect(resolveScale(Number.MIN_VALUE, 1)).toBe(1);
	});
});
