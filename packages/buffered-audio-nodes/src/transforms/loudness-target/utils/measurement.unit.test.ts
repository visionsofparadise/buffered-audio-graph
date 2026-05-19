import { ChunkBuffer } from "@buffered-audio/core";
import { afterEach, describe, expect, it } from "vitest";
import { measureSource } from "./measurement";

const SAMPLE_RATE = 48_000;

/** Provisional default percentile from plan §"Approach" item 1. */
const LIMIT_PERCENTILE = 0.995;

/**
 * Pool half-width passed to `measureSource` — matches the apply path's
 * `windowSamplesFromMs(smoothingMs, baseRate)`. Using ~1 ms at 48 kHz
 * (48 samples) keeps the pooled-axis behaviour close to per-sample for
 * shape tests while still exercising the post-2026-05-13 pooled
 * histogram code path. The tests below assert qualitative ordering
 * (limit > pivot, limit ≤ truePeak) which holds under any non-degenerate
 * pool width.
 */
const HALF_WIDTH = 48;

/**
 * Buffers created by `makeBufferFromChannels` during a test. The
 * `afterEach` hook below drains and closes them so the test suite
 * does not leak `%TEMP%\chunk-buffer-*.bin` files.
 */
const buffersToClose: ChunkBuffer[] = [];

/**
 * Wrap per-channel synthetic arrays in a `ChunkBuffer`. Mirrors
 * the helper from `iterate.unit.test.ts`.
 */
async function makeBufferFromChannels(channels: ReadonlyArray<Float32Array>): Promise<ChunkBuffer> {
	const buffer = new ChunkBuffer();

	await buffer.write(channels.map((channel) => new Float32Array(channel)), SAMPLE_RATE, 32);
	await buffer.flushWrites();

	buffersToClose.push(buffer);

	return buffer;
}

/** LCG (numerical-recipes constants) for deterministic noise. */
function makeLcg(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

		return state / 0x80_00_00_00 - 1;
	};
}

describe("measureSource — limitAutoDb (top-down percentile walk)", () => {
	afterEach(async () => {
		for (const buf of buffersToClose) {
			await buf.close();
		}

		buffersToClose.length = 0;
	});

	it("sine source with anomalous transients → limitAutoDb sits in the upper portion of the detection range", async () => {
		// 8-second mono 220 Hz sine at body amplitude 0.05 (≈ -26 dBFS
		// linear peak) with rare anomalous transients at 0.7 amplitude
		// (≈ -3 dBFS) sprinkled at low density. The percentile walk
		// from the top accumulates the rare-tail transient buckets
		// first, then descends through (mostly empty) intermediate
		// buckets until reaching the dense sine-body buckets near
		// 0.05. With `limitPercentile = 0.995` (target ≈ 0.5% of
		// total detection samples) the cumulative count is exceeded
		// somewhere between the transient cluster and the upper
		// envelope of the sine body — i.e. the upper portion of the
		// detection range, well above the pivot (median body level)
		// and below the true peak (transient level).
		const durationSeconds = 8;
		const frames = SAMPLE_RATE * durationSeconds;
		const channel = new Float32Array(frames);
		const angularStep = (2 * Math.PI * 220) / SAMPLE_RATE;
		const rand = makeLcg(0xAB_CD_12_34);

		for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
			channel[frameIndex] = 0.05 * Math.sin(angularStep * frameIndex);
		}

		// Sprinkle anomalous transients: 1 transient per 200 ms,
		// each 4 samples wide at 0.7 amplitude. Total ≈ 40 transient
		// regions × 4 samples = 160 anomalous samples at base rate.
		const transientStride = Math.floor(SAMPLE_RATE * 0.2);
		const transientWidth = 4;

		for (let transientStart = transientStride; transientStart < frames - transientWidth; transientStart += transientStride) {
			const jitter = Math.floor(rand() * 1000);
			const start = Math.min(frames - transientWidth, Math.max(0, transientStart + jitter));

			for (let offset = 0; offset < transientWidth; offset++) {
				channel[start + offset] = 0.7 * Math.sign(channel[start + offset] ?? 1);
			}
		}

		const buffer = await makeBufferFromChannels([channel]);
		const result = await measureSource(buffer, SAMPLE_RATE, LIMIT_PERCENTILE, HALF_WIDTH);

		// Sanity: pivot finite and well below the transient level.
		expect(Number.isFinite(result.pivotAutoDb)).toBe(true);
		expect(Number.isFinite(result.truePeakDb)).toBe(true);
		expect(Number.isFinite(result.limitAutoDb)).toBe(true);

		// Quantitative band (post-2026-05-13 pooled-axis fix): each
		// 4-sample transient is amplified by the `SlidingWindowMaxStream`
		// to fill its full `2·halfWidth+1` window. With HALF_WIDTH=48
		// and ~40 transients, ~40·(2·48+5) ≈ 4000 pooled samples sit at
		// the transient amplitude (~0.7 linear ≈ -3 dBFS) out of
		// 8·48000 ≈ 384000 total — ~1 % of the pooled distribution.
		// That exceeds the 0.5 % target, so the top-down walk now
		// terminates inside the transient cluster, near the true peak.
		expect(result.limitAutoDb).toBeGreaterThan(result.pivotAutoDb);
		expect(result.limitAutoDb).toBeLessThanOrEqual(result.truePeakDb);
		expect(result.limitAutoDb).toBeGreaterThan(-10);
		expect(result.limitAutoDb).toBeLessThan(0);
	});

	it("flat sine wave → limitAutoDb lands near the true peak", async () => {
		// Pure 220 Hz sine at amplitude 0.3. The 4×-rate max-linked
		// detection signal has the arcsine distribution — |x|
		// concentrates near the peak amplitude, so the histogram is
		// dense in the topmost buckets. Top-down walk to 0.5%
		// percentile target hits a near-top bucket almost immediately:
		// `limitAutoDb` lands within a small dB of `truePeakDb`.
		const durationSeconds = 8;
		const frames = SAMPLE_RATE * durationSeconds;
		const channel = new Float32Array(frames);
		const angularStep = (2 * Math.PI * 220) / SAMPLE_RATE;

		for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
			channel[frameIndex] = 0.3 * Math.sin(angularStep * frameIndex);
		}

		const buffer = await makeBufferFromChannels([channel]);
		const result = await measureSource(buffer, SAMPLE_RATE, LIMIT_PERCENTILE, HALF_WIDTH);

		expect(Number.isFinite(result.pivotAutoDb)).toBe(true);
		expect(Number.isFinite(result.truePeakDb)).toBe(true);
		expect(Number.isFinite(result.limitAutoDb)).toBe(true);

		expect(result.limitAutoDb).toBeGreaterThan(result.pivotAutoDb);
		expect(result.limitAutoDb).toBeLessThanOrEqual(result.truePeakDb);
		// Arcsine concentration → percentile sits within ~0.5 dB of
		// the true peak.
		expect(Math.abs(result.limitAutoDb - result.truePeakDb)).toBeLessThan(0.5);
	});

	it("non-silent source surfaces a non-empty shortTermLufs block series", async () => {
		// `solveTargets` (Phase 2 of `plan-loudness-target-deterministic`)
		// consumes `shortTermLufs` as the discrete level distribution it
		// inverts against `targetLufs`. The series must be populated for
		// any source long enough to produce at least one 3-second
		// short-term block.
		const durationSeconds = 8;
		const frames = SAMPLE_RATE * durationSeconds;
		const channel = new Float32Array(frames);
		const angularStep = (2 * Math.PI * 220) / SAMPLE_RATE;

		for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
			channel[frameIndex] = 0.3 * Math.sin(angularStep * frameIndex);
		}

		const buffer = await makeBufferFromChannels([channel]);
		const result = await measureSource(buffer, SAMPLE_RATE, LIMIT_PERCENTILE, HALF_WIDTH);

		expect(result.shortTermLufs.length).toBeGreaterThan(0);
		// All blocks finite for a non-silent sine — sanity that the
		// pass-through from `LoudnessAccumulator.finalize().shortTerm`
		// did not include any -Infinity / NaN entries that would poison
		// the solver's predict step.
		for (const blockLufs of result.shortTermLufs) {
			expect(Number.isFinite(blockLufs)).toBe(true);
		}
	});

	it("silent source → limitAutoDb = +Infinity", async () => {
		// 8 seconds of pure zeros. `AmplitudeHistogramAccumulator`
		// reports bucketMax = 0; `computeLimitAutoDb` short-circuits
		// to the no-limit sentinel.
		const durationSeconds = 8;
		const frames = SAMPLE_RATE * durationSeconds;
		const channel = new Float32Array(frames);

		const buffer = await makeBufferFromChannels([channel]);
		const result = await measureSource(buffer, SAMPLE_RATE, LIMIT_PERCENTILE, HALF_WIDTH);

		expect(result.limitAutoDb).toBe(Number.POSITIVE_INFINITY);
	});
});
