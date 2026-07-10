import { describe, expect, it } from "vitest";
import { resolveTruePeakGain } from "./gain";

describe("resolveTruePeakGain", () => {
	it("computes the gain that moves the source peak to the target", () => {
		const { gain, sourceTpDb } = resolveTruePeakGain(0.5, -1);

		expect(sourceTpDb).toBeCloseTo(20 * Math.log10(0.5), 6);
		expect(gain).toBeCloseTo(Math.pow(10, -1 / 20) / 0.5, 6);
	});

	it("returns unity gain and -Infinity dB for a silent source", () => {
		expect(resolveTruePeakGain(0, -1)).toEqual({ gain: 1, sourceTpDb: -Infinity });
	});

	it("attenuates a source already above the target", () => {
		const { gain } = resolveTruePeakGain(1, -3);

		expect(gain).toBeCloseTo(Math.pow(10, -3 / 20), 6);
		expect(gain).toBeLessThan(1);
	});
});
