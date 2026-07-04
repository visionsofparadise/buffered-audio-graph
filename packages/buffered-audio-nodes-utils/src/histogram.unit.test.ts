import { describe, expect, it } from "vitest";
import { amplitudeHistogram } from "./histogram";

function makeUniformHalfOpen(length: number, seed: number): Float32Array {
	// Deterministic LCG (Numerical Recipes) so tests are reproducible.
	const buffer = new Float32Array(length);
	let state = seed >>> 0;

	for (let index = 0; index < length; index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		buffer[index] = state / 0x1_0000_0000;
	}

	return buffer;
}

function makeGaussian(length: number, sigma: number, seed: number): Float32Array {
	const buffer = new Float32Array(length);
	let state = seed >>> 0;
	const nextUniform = (): number => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

		// Avoid exactly 0 to keep log(u) finite.
		return (state + 1) / 0x1_0000_0001;
	};

	for (let index = 0; index < length; index += 2) {
		const u1 = nextUniform();
		const u2 = nextUniform();
		const r = Math.sqrt(-2 * Math.log(u1));
		const theta = 2 * Math.PI * u2;

		buffer[index] = sigma * r * Math.cos(theta);

		if (index + 1 < length) buffer[index + 1] = sigma * r * Math.sin(theta);
	}

	return buffer;
}

describe("amplitudeHistogram", () => {
	it("uniform [0, 1): median ≈ 0.5 and buckets are roughly equal", () => {
		const samples = makeUniformHalfOpen(200_000, 42);
		const result = amplitudeHistogram([samples], 256);

		expect(result.bucketMax).toBeGreaterThan(0.99);
		expect(result.bucketMax).toBeLessThanOrEqual(1);
		expect(result.median).toBeGreaterThan(0.48);
		expect(result.median).toBeLessThan(0.52);

		// Bucket counts should sit near totalSamples / bucketCount.
		const expected = samples.length / result.buckets.length;
		const tolerance = expected * 0.25;
		let maxDeviation = 0;

		for (let bucketIndex = 0; bucketIndex < result.buckets.length; bucketIndex++) {
			const deviation = Math.abs((result.buckets[bucketIndex] ?? 0) - expected);

			if (deviation > maxDeviation) maxDeviation = deviation;
		}

		expect(maxDeviation).toBeLessThan(tolerance);
	});

	it("Gaussian N(0, σ²): median(|x|) ≈ σ × 0.6745 (half-normal median)", () => {
		const sigma = 0.2;
		const samples = makeGaussian(400_000, sigma, 7);
		const result = amplitudeHistogram([samples], 1024);

		// Median of |X| for X ~ N(0, σ²) is σ × Φ⁻¹(0.75) ≈ 0.6745σ.
		const expectedMedian = sigma * 0.6744897501960817;

		expect(result.median).toBeGreaterThan(expectedMedian * 0.95);
		expect(result.median).toBeLessThan(expectedMedian * 1.05);
		expect(result.bucketMax).toBeGreaterThan(sigma * 2);
	});

	it("all-zero input: bucketMax = 0, median = 0, all bucket counts zero", () => {
		const samples = new Float32Array(1024);
		const result = amplitudeHistogram([samples], 32);

		expect(result.bucketMax).toBe(0);
		expect(result.median).toBe(0);

		for (let bucketIndex = 0; bucketIndex < result.buckets.length; bucketIndex++) {
			expect(result.buckets[bucketIndex]).toBe(0);
		}
	});

	it("single non-zero sample: bucketMax equals |sample|, median lies in the last bucket", () => {
		const samples = new Float32Array(1);

		samples[0] = -0.42;

		const result = amplitudeHistogram([samples], 16);

		expect(result.bucketMax).toBeCloseTo(0.42, 6);
		// One sample, target 0.5, cumulative passes 0.5 inside the last bucket at fraction 0.5 → median at 15.5/16 × 0.42.
		expect(result.median).toBeCloseTo((15.5 / 16) * 0.42, 5);
	});

	it("empty input: returns zeros without throwing", () => {
		const result = amplitudeHistogram([new Float32Array(0)], 8);

		expect(result.bucketMax).toBe(0);
		expect(result.median).toBe(0);
		expect(result.buckets.length).toBe(8);
	});

	it("multiple channels are combined into one distribution", () => {
		const left = new Float32Array([0.1, 0.2, 0.3, 0.4]);
		const right = new Float32Array([-0.5, -0.6, -0.7, -0.8]);
		const result = amplitudeHistogram([left, right], 8);

		// Eight unique |x| values evenly spaced in [0.1, 0.8], target cumulative 4 → median near the 4th/5th boundary ≈ 0.45.
		expect(result.bucketMax).toBeCloseTo(0.8, 6);
		expect(result.median).toBeGreaterThan(0.4);
		expect(result.median).toBeLessThan(0.55);

		let total = 0;

		for (let bucketIndex = 0; bucketIndex < result.buckets.length; bucketIndex++) {
			total += result.buckets[bucketIndex] ?? 0;
		}

		expect(total).toBe(8);
	});

	it("rejects non-positive bucketCount", () => {
		const samples = new Float32Array([0.1, 0.2]);

		expect(() => amplitudeHistogram([samples], 0)).toThrow();
		expect(() => amplitudeHistogram([samples], -1)).toThrow();
		expect(() => amplitudeHistogram([samples], 1.5)).toThrow();
	});
});
