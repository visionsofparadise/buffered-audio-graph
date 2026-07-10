import { describe, expect, it } from "vitest";
import { resolveLoudnessGain } from "./gain";

describe("resolveLoudnessGain", () => {
	it("computes the linear gain from the measured-to-target LUFS delta", () => {
		expect(resolveLoudnessGain(-23, -16)).toBeCloseTo(Math.pow(10, 7 / 20), 6);
	});

	it("attenuates when the source is louder than the target", () => {
		const gain = resolveLoudnessGain(-10, -16);

		expect(gain).toBeCloseTo(Math.pow(10, -6 / 20), 6);
		expect(gain).toBeLessThan(1);
	});

	it("returns unity gain for a silent (-Infinity) measurement", () => {
		expect(resolveLoudnessGain(-Infinity, -16)).toBe(1);
	});

	it("returns unity gain for a NaN measurement", () => {
		expect(resolveLoudnessGain(NaN, -16)).toBe(1);
	});
});
