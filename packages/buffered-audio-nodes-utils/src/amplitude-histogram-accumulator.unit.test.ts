import { describe, expect, it } from "vitest";
import { AmplitudeHistogramAccumulator } from "./amplitude-histogram-accumulator";
import { amplitudeHistogram } from "./histogram";

function sumBuckets(buckets: Uint32Array): number {
	let total = 0;

	for (let index = 0; index < buckets.length; index++) {
		total += buckets[index] ?? 0;
	}

	return total;
}

function makeRamp(length: number, amplitude: number): Float32Array {
	const buffer = new Float32Array(length);

	for (let index = 0; index < length; index++) {
		buffer[index] = (index / (length - 1)) * amplitude;
	}

	return buffer;
}

describe("AmplitudeHistogramAccumulator", () => {
	it("empty input: no push → zero buckets, bucketMax 0, median 0", () => {
		const accumulator = new AmplitudeHistogramAccumulator(32);
		const result = accumulator.finalize();

		expect(result.bucketMax).toBe(0);
		expect(result.median).toBe(0);
		expect(result.buckets.length).toBe(32);
		expect(sumBuckets(result.buckets)).toBe(0);
	});

	it("single chunk parity vs one-shot: same bucketMax, exact buckets, same median", () => {
		const samples = new Float32Array([0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, -0.5, -0.6, -0.7]);
		const oneShot = amplitudeHistogram([samples], 16);

		const accumulator = new AmplitudeHistogramAccumulator(16);

		accumulator.push([samples], samples.length);

		const streamed = accumulator.finalize();

		expect(streamed.bucketMax).toBe(oneShot.bucketMax);
		expect(streamed.median).toBeCloseTo(oneShot.median, 10);
		expect(streamed.buckets.length).toBe(oneShot.buckets.length);

		for (let bucketIndex = 0; bucketIndex < oneShot.buckets.length; bucketIndex++) {
			expect(streamed.buckets[bucketIndex]).toBe(oneShot.buckets[bucketIndex]);
		}
	});

	it("chunked parity: split a signal across N chunks → same bucketMax, same total, similar median", () => {
		// Random-ish ramp (deterministic LCG) so the max stabilises early and chunked rebucketing is exercised.
		const length = 12_000;
		const samples = new Float32Array(length);
		let state = 1234 >>> 0;

		for (let index = 0; index < length; index++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			samples[index] = (state / 0x1_0000_0000) * 0.9 - 0.45;
		}

		const oneShot = amplitudeHistogram([samples], 256);

		// 7 unequal chunks to force varied chunk boundaries.
		const chunkSizes = [97, 4096, 503, 2048, 1700, 2500, 1056];
		const accumulator = new AmplitudeHistogramAccumulator(256);
		let cursor = 0;

		for (const size of chunkSizes) {
			const slice = samples.subarray(cursor, cursor + size);

			accumulator.push([slice], size);

			cursor += size;
		}

		expect(cursor).toBe(length);

		const streamed = accumulator.finalize();

		// bucketMax matches exactly — same running max of |x|.
		expect(streamed.bucketMax).toBe(oneShot.bucketMax);

		// sum(buckets) is exact — rebucketing is sample-count-conserving.
		expect(sumBuckets(streamed.buckets)).toBe(sumBuckets(oneShot.buckets));

		// Median only similar — rebucketing precision can shift it by < one bucket width.
		const bucketWidth = oneShot.bucketMax / 256;

		expect(Math.abs(streamed.median - oneShot.median)).toBeLessThan(bucketWidth);
	});

	it("rebucketing across chunks: chunk1 max 0.3, chunk2 max 0.7 → bucketMax 0.7 with conserved counts", () => {
		const bucketCount = 64;
		const accumulator = new AmplitudeHistogramAccumulator(bucketCount);

		const chunk1 = makeRamp(1000, 0.3);

		accumulator.push([chunk1], chunk1.length);

		// Chunk 2 ramps to 0.7 — exceeds prior bucketMax, triggers rebucket.
		const chunk2 = makeRamp(2000, 0.7);

		accumulator.push([chunk2], chunk2.length);

		const result = accumulator.finalize();

		// Float32 storage rounds 0.7 → ~0.6999999881, so assert at single-precision tolerance.
		expect(result.bucketMax).toBeCloseTo(0.7, 6);
		expect(sumBuckets(result.buckets)).toBe(chunk1.length + chunk2.length);

		// Bucket index for 0.3 is floor(0.3*64/0.7)=27; chunk-1 contributions (max 0.3) sit in the lower ~3/7 of buckets after rebucketing, with slack for boundary mapping.
		let upperHalfCount = 0;

		for (let bucketIndex = 30; bucketIndex < bucketCount; bucketIndex++) {
			upperHalfCount += result.buckets[bucketIndex] ?? 0;
		}

		// chunk2 is a uniform ramp [0, 0.7], so values >= 0.33 are ~53% of 2000 ≈ 1050 samples.
		expect(upperHalfCount).toBeGreaterThan(800);
		expect(upperHalfCount).toBeLessThan(1300);
	});

	it("constructor validates bucketCount", () => {
		expect(() => new AmplitudeHistogramAccumulator(0)).toThrow();
		expect(() => new AmplitudeHistogramAccumulator(-1)).toThrow();
		expect(() => new AmplitudeHistogramAccumulator(1.5)).toThrow();
	});

	it("push validates per-channel buffer length against frames", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);
		const channel = new Float32Array(8);

		expect(() => accumulator.push([channel], 16)).toThrow();
	});

	it("re-finalize is idempotent (returns the same result object)", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);

		accumulator.push([new Float32Array([0.1, 0.2, 0.3, 0.4])], 4);

		const first = accumulator.finalize();
		const second = accumulator.finalize();

		expect(second).toBe(first);
		expect(second.bucketMax).toBe(first.bucketMax);
		expect(second.median).toBe(first.median);
	});

	it("push after finalize throws", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);

		accumulator.push([new Float32Array([0.1, 0.2])], 2);
		accumulator.finalize();

		expect(() => accumulator.push([new Float32Array([0.3])], 1)).toThrow();
	});

	it("multi-channel: combined distribution; bucketMax = max across channels", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);
		const left = new Float32Array([0.1, 0.2, 0.3, 0.4, -0.5]);
		const right = new Float32Array([0.6, 0.7, 0.8, -0.9, 0.05]);

		accumulator.push([left, right], 5);

		const result = accumulator.finalize();

		expect(result.bucketMax).toBeCloseTo(0.9, 6);
		// 5 samples per channel × 2 channels = 10 total.
		expect(sumBuckets(result.buckets)).toBe(10);
	});

	it("all-zero chunks before a nonzero chunk: silent samples are flushed into bucket 0", () => {
		// Pushing silence then a real signal must conserve total samples and place silence in bucket 0.
		const accumulator = new AmplitudeHistogramAccumulator(16);
		const silence = new Float32Array(500);
		const signal = new Float32Array([0.4, 0.5, 0.6, 0.7, 0.8]);

		accumulator.push([silence], silence.length);
		accumulator.push([signal], signal.length);

		const result = accumulator.finalize();

		expect(result.bucketMax).toBeCloseTo(0.8, 6);
		expect(sumBuckets(result.buckets)).toBe(silence.length + signal.length);
		expect(result.buckets[0]).toBe(500);
	});

	it("only-silence: bucketMax 0, median 0, all-zero buckets even after pushes", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);

		accumulator.push([new Float32Array(1000)], 1000);
		accumulator.push([new Float32Array(2000)], 2000);

		const result = accumulator.finalize();

		expect(result.bucketMax).toBe(0);
		expect(result.median).toBe(0);
		expect(sumBuckets(result.buckets)).toBe(0);
	});
});
