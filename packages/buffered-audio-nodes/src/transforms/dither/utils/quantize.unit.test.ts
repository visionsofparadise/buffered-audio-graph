import { describe, expect, it } from "vitest";
import { quantizationLevels, quantizeSample } from "./quantize";

describe("quantizationLevels", () => {
	it("returns 2^15 for 16-bit", () => {
		expect(quantizationLevels(16)).toBe(32768);
	});

	it("returns 2^23 for 24-bit", () => {
		expect(quantizationLevels(24)).toBe(8388608);
	});
});

describe("quantizeSample", () => {
	it("snaps a value onto the quantization grid", () => {
		const levels = 32768;
		const result = quantizeSample(0.123456, levels);

		expect(result).toBe(Math.round(0.123456 * levels) / levels);
		expect(Math.abs(result - 0.123456)).toBeLessThan(1 / levels);
	});

	it("leaves 0 at 0", () => {
		expect(quantizeSample(0, 32768)).toBe(0);
	});

	it("keeps a value already on the grid exactly", () => {
		const levels = 32768;
		const onGrid = 100 / levels;

		expect(quantizeSample(onGrid, levels)).toBe(onGrid);
	});
});
