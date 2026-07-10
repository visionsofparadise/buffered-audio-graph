import { describe, expect, it } from "vitest";
import { downmixToMono } from "./mix";

describe("downmixToMono", () => {
	it("averages stereo channels", () => {
		const mono = downmixToMono([new Float32Array([0.8, 0.2]), new Float32Array([0.4, 0.6])]);

		expect(mono[0]).toBeCloseTo(0.6, 6);
		expect(mono[1]).toBeCloseTo(0.4, 6);
	});

	it("averages four channels", () => {
		const mono = downmixToMono([new Float32Array([0.4]), new Float32Array([0.8]), new Float32Array([0.2]), new Float32Array([0.6])]);

		expect(mono[0]).toBeCloseTo(0.5, 6);
	});

	it("cancels opposite-sign channels", () => {
		const mono = downmixToMono([new Float32Array([0.5]), new Float32Array([-0.5])]);

		expect(mono[0]).toBeCloseTo(0, 6);
	});

	it("returns a scaled copy for a single channel", () => {
		const mono = downmixToMono([new Float32Array([0.3, -0.7])]);

		expect(mono[0]).toBeCloseTo(0.3, 6);
		expect(mono[1]).toBeCloseTo(-0.7, 6);
	});

	it("returns an empty array for no channels", () => {
		expect(downmixToMono([]).length).toBe(0);
	});
});
