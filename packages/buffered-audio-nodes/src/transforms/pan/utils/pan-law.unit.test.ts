import { describe, expect, it } from "vitest";
import { balanceScales, panGains } from "./pan-law";

describe("panGains", () => {
	it("splits equal power at center", () => {
		const { leftGain, rightGain } = panGains(0);

		expect(leftGain).toBeCloseTo(Math.SQRT2 / 2, 6);
		expect(rightGain).toBeCloseTo(Math.SQRT2 / 2, 6);
		expect(leftGain ** 2 + rightGain ** 2).toBeCloseTo(1, 6);
	});

	it("sends all energy left at full left", () => {
		const { leftGain, rightGain } = panGains(-1);

		expect(leftGain).toBeCloseTo(1, 6);
		expect(rightGain).toBeCloseTo(0, 6);
	});

	it("sends all energy right at full right", () => {
		const { leftGain, rightGain } = panGains(1);

		expect(leftGain).toBeCloseTo(0, 6);
		expect(rightGain).toBeCloseTo(1, 6);
	});
});

describe("balanceScales", () => {
	it("keeps both channels at unity at center", () => {
		expect(balanceScales(0)).toEqual({ leftScale: 1, rightScale: 1 });
	});

	it("silences the right channel at full left", () => {
		expect(balanceScales(-1)).toEqual({ leftScale: 1, rightScale: 0 });
	});

	it("halves the left channel at half right while keeping the right at unity", () => {
		expect(balanceScales(0.5)).toEqual({ leftScale: 0.5, rightScale: 1 });
	});
});
