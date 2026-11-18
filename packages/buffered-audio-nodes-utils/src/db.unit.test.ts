import { describe, expect, it } from "vitest";
import { dbToLinear } from "./db";

describe("dbToLinear", () => {
	it("converts 0 dB to 1.0", () => {
		expect(dbToLinear(0)).toBe(1.0);
	});

	it("converts -20 dB to 0.1", () => {
		expect(dbToLinear(-20)).toBeCloseTo(0.1, 6);
	});

	it("converts +20 dB to 10.0", () => {
		expect(dbToLinear(20)).toBeCloseTo(10.0, 6);
	});

	it("converts -Infinity to 0", () => {
		expect(dbToLinear(-Infinity)).toBe(0);
	});
});
