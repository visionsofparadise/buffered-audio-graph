import { describe, expect, it } from "vitest";
import { applyAllpass, invertSamples, phaseCoefficient } from "./phase-shift";

describe("invertSamples", () => {
	it("negates every sample across channels", () => {
		const out = invertSamples([new Float32Array([0.5, -0.25]), new Float32Array([1, -1])]);

		expect(Array.from(out[0]!)).toEqual([-0.5, 0.25]);
		expect(Array.from(out[1]!)).toEqual([-1, 1]);
	});

	it("returns an empty channel for empty input", () => {
		expect(invertSamples([new Float32Array(0)])[0]!.length).toBe(0);
	});
});

describe("phaseCoefficient", () => {
	it("is 0 at 180 degrees", () => {
		expect(phaseCoefficient(180)).toBeCloseTo(0, 12);
	});

	it("is -1 at 0 degrees", () => {
		expect(phaseCoefficient(0)).toBeCloseTo(-1, 12);
	});
});

describe("applyAllpass", () => {
	it("acts as a one-sample delay when the coefficient is 0 and carries state out", () => {
		const { output, state } = applyAllpass(new Float32Array([1, 2, 3]), 0, 0);

		expect(Array.from(output)).toEqual([0, 1, 2]);
		expect(state).toBe(3);
	});

	it("continues from the incoming state", () => {
		const { output } = applyAllpass(new Float32Array([4, 5]), 0, 9);

		expect(output[0]).toBe(9);
		expect(output[1]).toBe(4);
	});

	it("returns an empty output and the unchanged state for an empty channel", () => {
		const { output, state } = applyAllpass(new Float32Array(0), 0.5, 7);

		expect(output.length).toBe(0);
		expect(state).toBe(7);
	});
});
