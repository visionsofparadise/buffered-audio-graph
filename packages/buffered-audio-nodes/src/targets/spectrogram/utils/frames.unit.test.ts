import { describe, it, expect } from "vitest";
import { computeFrameMagnitudes } from "./frames";

describe("computeFrameMagnitudes", () => {
	// Linear path (no band mapping): magnitude = sqrt(re^2 + im^2) * magScale per bin.
	it("computes scaled linear-bin magnitudes", () => {
		const re = Float32Array.from([3, 6]);
		const im = Float32Array.from([4, 8]);
		const result = computeFrameMagnitudes(re, im, 0, 2, 1, 2, undefined, new Float32Array(2));

		expect(Array.from(result)).toEqual([5, 10]);
	});

	it("applies the magnitude scale", () => {
		const re = Float32Array.from([3, 6]);
		const im = Float32Array.from([4, 8]);
		const result = computeFrameMagnitudes(re, im, 0, 2, 0.5, 2, undefined, new Float32Array(2));

		expect(Array.from(result)).toEqual([2.5, 5]);
	});

	// reOffset selects the frame's slice within a contiguous batch buffer.
	it("reads from the frame offset", () => {
		const re = Float32Array.from([0, 0, 3, 6]);
		const im = Float32Array.from([0, 0, 4, 8]);
		const result = computeFrameMagnitudes(re, im, 2, 2, 1, 2, undefined, new Float32Array(2));

		expect(Array.from(result)).toEqual([5, 10]);
	});

	// Band mapping: weighted average over [binStart, binEnd] with fractional edge weights.
	it("aggregates bins into a band with edge weights", () => {
		const re = Float32Array.from([3, 6]);
		const im = Float32Array.from([4, 8]); // magnitudes 5, 10
		const bandMappings = [{ binStart: 0, binEnd: 1, weightStart: 0.5, weightEnd: 1 }];
		const result = computeFrameMagnitudes(re, im, 0, 2, 1, 1, bandMappings, new Float32Array(2));

		// (5*0.5 + 10*1) / (0.5 + 1) = 12.5 / 1.5
		expect(result[0]).toBeCloseTo(12.5 / 1.5, 5);
	});

	// Interior bins carry weight 1; only the band edges are fractional.
	it("weights interior band bins fully", () => {
		const re = Float32Array.from([2, 4, 6]);
		const im = Float32Array.from([0, 0, 0]); // magnitudes 2, 4, 6
		const bandMappings = [{ binStart: 0, binEnd: 2, weightStart: 1, weightEnd: 1 }];
		const result = computeFrameMagnitudes(re, im, 0, 3, 1, 1, bandMappings, new Float32Array(3));

		// (2 + 4 + 6) / 3 = 4
		expect(result[0]).toBeCloseTo(4, 5);
	});
});
