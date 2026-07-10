import { describe, it, expect } from "vitest";
import { buildTriangularWeight } from "./dsp";

describe("buildTriangularWeight", () => {
	// Linear triangle (power 1): rises to the midpoint, mirrors down.
	it("builds a symmetric linear triangle at power 1", () => {
		const weight = buildTriangularWeight(8, 1);

		expect(Array.from(weight)).toEqual([0.25, 0.5, 0.75, 1, 1, 0.75, 0.5, 0.25]);
	});

	// Power shapes the ramp: each half-value is squared at power 2.
	it("raises the ramp to the transition power", () => {
		const weight = buildTriangularWeight(8, 2);

		expect(weight[0]).toBeCloseTo(0.0625, 6); // (1/4)^2
		expect(weight[1]).toBeCloseTo(0.25, 6); // (2/4)^2
		expect(weight[3]).toBeCloseTo(1, 6);
	});

	// Invariants: full length, mirror symmetry, peak at the center.
	it("is length-exact and symmetric about the midpoint", () => {
		const n = 16;
		const weight = buildTriangularWeight(n, 1);

		expect(weight.length).toBe(n);
		for (let index = 0; index < n; index++) {
			expect(weight[index]).toBeCloseTo(weight[n - 1 - index] ?? 0, 6);
		}
		expect(weight[n / 2 - 1]).toBeCloseTo(1, 6);
	});
});
