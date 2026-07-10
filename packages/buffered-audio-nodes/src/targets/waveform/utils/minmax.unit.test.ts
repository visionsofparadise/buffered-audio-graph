import { describe, it, expect } from "vitest";
import { updateMinMax, writeMinMaxPoint } from "./minmax";

describe("updateMinMax", () => {
	// Running min/max reduction across frames, per channel.
	it("tracks per-channel min and max across frames", () => {
		const samples = [Float32Array.from([0.5, -0.8]), Float32Array.from([-0.3, 0.9])];
		const min = new Float32Array(2).fill(1);
		const max = new Float32Array(2).fill(-1);

		updateMinMax(samples, 0, 2, min, max);
		updateMinMax(samples, 1, 2, min, max);

		expect(min[0]).toBeCloseTo(-0.8, 6);
		expect(min[1]).toBeCloseTo(-0.3, 6);
		expect(max[0]).toBeCloseTo(0.5, 6);
		expect(max[1]).toBeCloseTo(0.9, 6);
	});

	// A single frame within the neutral [1, -1] seed sets both bounds to that sample.
	it("collapses min and max onto a single sample", () => {
		const samples = [Float32Array.from([0.25])];
		const min = new Float32Array(1).fill(1);
		const max = new Float32Array(1).fill(-1);

		updateMinMax(samples, 0, 1, min, max);

		expect(min[0]).toBeCloseTo(0.25, 6);
		expect(max[0]).toBeCloseTo(0.25, 6);
	});
});

describe("writeMinMaxPoint", () => {
	// Point layout: per channel, [min float32][max float32] = 8 bytes.
	it("writes interleaved min/max floats at the channel stride", () => {
		const min = Float32Array.from([0.5, -0.2]);
		const max = Float32Array.from([0.7, 0.1]);
		const target = Buffer.alloc(16);

		writeMinMaxPoint(min, max, 2, target, 0);

		expect(target.readFloatLE(0)).toBeCloseTo(0.5, 6);
		expect(target.readFloatLE(4)).toBeCloseTo(0.7, 6);
		expect(target.readFloatLE(8)).toBeCloseTo(-0.2, 6);
		expect(target.readFloatLE(12)).toBeCloseTo(0.1, 6);
	});

	it("honours the write offset", () => {
		const target = Buffer.alloc(16);

		writeMinMaxPoint(Float32Array.from([-0.5]), Float32Array.from([0.5]), 1, target, 8);

		expect(target.readFloatLE(8)).toBeCloseTo(-0.5, 6);
		expect(target.readFloatLE(12)).toBeCloseTo(0.5, 6);
	});
});
