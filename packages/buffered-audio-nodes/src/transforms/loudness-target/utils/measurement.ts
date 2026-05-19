import type { ChunkBuffer } from "@buffered-audio/core";
import {
	AmplitudeHistogramAccumulator,
	LoudnessAccumulator,
	SlidingWindowMaxStream,
	TruePeakAccumulator,
	TruePeakUpsampler,
	dbToLinear,
	getLraConsideredStats,
	linearToDb,
} from "@buffered-audio/utils";
import { OVERSAMPLE_FACTOR } from "./iterate";

/**
 * Combined source measurement for the loudnessTarget node.
 *
 * Per design-loudness-target §"Pipeline shape": pass 1 measures
 * integrated LUFS, LRA, and 4× true peak in a single chunked walk
 * through the source. The expander's `measurement.ts` measures only
 * integrated LUFS (no peak anchor); this module extends that pattern
 * with a parallel {@link TruePeakAccumulator} and uses
 * {@link LoudnessAccumulator} (rather than `IntegratedLufsAccumulator`)
 * to get LRA in the same pass.
 *
 * The pass also carries a per-channel {@link TruePeakUpsampler} array, a
 * {@link SlidingWindowMaxStream} (instantiated at base rate with
 * `halfWidth = windowSamplesFromMs(smoothingMs, baseRate)`), and an
 * {@link AmplitudeHistogramAccumulator} over the POOLED base-rate
 * detection signal — i.e. `raw 4×: levels_4×[k] = max_c |upChannels[c][k]|`
 * collapsed to base rate by max-of-4 and then run through the
 * `SlidingWindowMaxStream`. This is the SAME signal the curve evaluates
 * per attempt in the apply path's `buildBaseRateDetectionCache` →
 * curve-eval chain. Matching axes so the percentile-derived
 * `limitAutoDb` lands on the same distribution the curve's brick-wall
 * branch actually sees (per the 2026-05-13 histogram-axis fix; prior
 * raw-4× axis under-estimated typical curve-input levels because the
 * pool collapses ~`(2·halfWidth+1)·4` raw samples into a single
 * curve-input sample by max).
 *
 * Walk granularity matches the rest of the loudness sub-system
 * (`44_100` frames per chunk). All accumulators consume the same
 * per-chunk channel slices in lockstep — single source pass, constant
 * memory beyond the bounded accumulator state.
 */

/**
 * Iteration chunk size — one second's worth of frames at 44.1 kHz,
 * the chunk granularity used across the loudness sub-system.
 */
const CHUNK_FRAMES = 44_100;

/**
 * Histogram bucket count for the detection-envelope amplitude histogram.
 * 1024 matches `AmplitudeHistogramAccumulator`'s typical resolution and
 * is well beyond what the percentile walk needs for level precision.
 */
const HISTOGRAM_BUCKETS = 1024;

/**
 * Fallback pivot for the silent-source / no-considered-blocks case.
 * Mirrors the same `-40 dBFS` fallback used in `index.ts`'s pivot auto-
 * derivation when `pivotAutoDb` is `+Infinity`. Keeps `dbToLinear`
 * finite so the start-bucket index is well-defined.
 */
const PIVOT_FALLBACK_DB = -40;

export interface SourceMeasurement {
	/**
	 * BS.1770-4 integrated loudness in LUFS. `-Infinity` for silent /
	 * sub-block-length signals; the caller treats this as a
	 * pass-through bail signal (no curve to fit).
	 */
	readonly integratedLufs: number;
	/**
	 * EBU Tech 3342 Loudness Range in LU. `0` when fewer than two
	 * short-term blocks survive the LRA two-stage gate (typical for
	 * sources < ~6 s or perfectly stationary content).
	 */
	readonly lra: number;
	/**
	 * 4× upsampled true peak in dBTP. `-Infinity` for silent input
	 * (linear amplitude 0 → `linearToDb` returns `-Infinity`).
	 */
	readonly truePeakDb: number;
	/**
	 * `median(consideredLra)` from the BS.1770 / EBU R128 LRA two-stage
	 * gate (absolute -70 LUFS, relative -20 LU below absolute-gated
	 * mean) computed in pass 1 over the short-term block series. Used
	 * directly as a detection-axis dBFS value (no unit conversion) by
	 * the auto-derived `pivot` default in the loudnessTarget node —
	 * the "typical body level" anchor. Median is robust to both
	 * transient-heavy and noise-floor-heavy tails of the considered
	 * set.
	 *
	 * `Number.POSITIVE_INFINITY` when no short-term blocks survive
	 * gating (empty `shortTerm` for sources < 3 s, or every block
	 * below the absolute -70 LUFS gate). Callers fall back to a
	 * sentinel pivot value in that case.
	 */
	readonly pivotAutoDb: number;
	/**
	 * `min(consideredLra)` from the BS.1770 / EBU R128 LRA two-stage
	 * gate computed in pass 1. Used as the auto-derived `floor`
	 * default in the loudnessTarget node — the absolute lower bound
	 * of the gain-riding zone (samples below this level were not
	 * loud enough to participate in perceived loudness). Pairs with
	 * the median `pivotAutoDb`: pivot=median sets the body anchor,
	 * floor=min sets the lower-segment roll-off start.
	 *
	 * `Number.POSITIVE_INFINITY` when no short-term blocks survive
	 * gating. Callers fall back to no-floor in that case.
	 */
	readonly floorAutoDb: number;
	/**
	 * Percentile-derived level on the POOLED base-rate detection
	 * histogram (raw 4× → max-of-4 → `SlidingWindowMaxStream(halfWidth)`),
	 * restricted to the `[pivotAutoDb, sourcePeakDb]` window. Returned in
	 * dBFS (negative for sub-unity amplitudes; computed via `linearToDb`
	 * of the bucket centre at the percentile).
	 *
	 * Semantics: the dB level above which the top
	 * `(1 - limitPercentile)` fraction of detection samples sit — the
	 * brick-wall threshold for those rare-tail peaks. Consumed by the
	 * loudnessTarget iterator as the fixed `limitDb` anchor when no
	 * explicit override is provided.
	 *
	 * `Number.POSITIVE_INFINITY` when the source is silent
	 * (`bucketMax === 0` / no samples) or the post-pivot histogram
	 * window contains fewer samples than the percentile target —
	 * degenerate cases where there is no useful limiting headroom.
	 * Callers fall back to `sourcePeakDb` in those cases (no limiting
	 * — the brick-wall branch never engages).
	 */
	readonly limitAutoDb: number;
	/**
	 * BS.1770 short-term LUFS block sequence — 3-second sliding RMS at
	 * 100 ms hop, K-weighted, ungated. Carried straight through from
	 * `LoudnessAccumulator.finalize().shortTerm`; no recomputation.
	 *
	 * Retained on the measurement for diagnostic / regression purposes
	 * and as the source of `pivotAutoDb` / `floorAutoDb`. NOT consumed
	 * by the deterministic solver's predictor: post the 2026-05-13
	 * histogram-axis fix the predictor reads `detectionHistogram` on the
	 * pooled base-rate axis — the same axis the apply path drives
	 * `gainDbAt` on — instead of the K-weighted block-LUFS series,
	 * which lives on a different axis (3-second RMS vs per-sample
	 * peaks, off by several dB).
	 *
	 * Empty for sources shorter than ~3 seconds (no short-term blocks
	 * complete) or perfectly silent input. Callers handle the empty
	 * case as a pass-through bail.
	 */
	readonly shortTermLufs: ReadonlyArray<number>;
	/**
	 * Amplitude histogram on the POOLED base-rate detection signal —
	 * the EXACT axis the curve evaluates on per attempt in the apply
	 * path's `buildBaseRateDetectionCache`. Pipeline:
	 *
	 *   raw 4× (`max_c |upChannels[c][k]|`)
	 *     → max-of-4 collapse to base rate
	 *     → `SlidingWindowMaxStream(halfWidth)` at base rate
	 *     → histogram
	 *
	 * `halfWidth` is the same `windowSamplesFromMs(smoothingMs,
	 * baseRate)` used by `buildBaseRateDetectionCache`. The percentile
	 * walk that derives `limitAutoDb` reads this same histogram, so
	 * `limitAutoDb` is calibrated against the distribution the curve
	 * actually sees.
	 *
	 * Consumed by `predictOutputLufs` (per `plan-loudness-target-
	 * deterministic` Phase 2 post-2026-05-13 fix) to estimate the
	 * integrated LUFS shift `10·log10(E[g²])` where `g(absXDb) =
	 * 10^(gainDbAt(absXDb, anchors)/20)`. NOTE: the predictor's
	 * energy-weighting math assumes the histogram is a per-sample
	 * source distribution; on the pooled axis pooled amplitudes are
	 * systematically higher than per-sample source amplitudes, biasing
	 * the predictor's seed estimate upward. This is an accepted
	 * trade-off (single histogram for both consumers; the predictor is
	 * only a seed — iteration's secant + proportional feedback drive
	 * actual convergence). Also: rate-flat K-filter approximation
	 * (<0.5 LUFS typical content; up to ~2 LUFS on high-crest-factor
	 * speech) and no BS.1770 block gating.
	 */
	readonly detectionHistogram: DetectionHistogram;
}

/**
 * Amplitude histogram on the POOLED base-rate detection signal — the
 * EXACT axis the curve evaluates on per attempt. Surfaced on
 * {@link SourceMeasurement} for the percentile-driven `limitAutoDb`
 * walk and for the LUFS-target predictor.
 *
 * Pipeline that fills the histogram (matches
 * `buildBaseRateDetectionCache` upstream of the curve):
 *
 *   raw 4× (`max_c |upChannels[c][k]|`)
 *     → max-of-4 collapse to base rate
 *     → `SlidingWindowMaxStream(halfWidth)` at base rate
 *     → histogram sample
 *
 * Linear-amplitude buckets in `[0, bucketMax)` from
 * `AmplitudeHistogramAccumulator.finalize()`, plus the total sample
 * count for normalisation.
 *
 * Bucket layout (matching `AmplitudeHistogramAccumulator`):
 *   - `bucketCount = buckets.length` (1024 in the current pipeline)
 *   - bucket `i` covers `[i·width, (i+1)·width)` where
 *     `width = bucketMax / bucketCount`
 *   - bucket centre linear amplitude: `(i + 0.5) · width`
 *
 * `totalSamples` is the sum of bucket counts; it equals base-rate
 * `framesProcessed` for the typical non-silent source (one histogram
 * sample per base-rate frame after the slider's leading-edge defer is
 * flushed by the final `isFinal=true` push).
 *
 * Empty / silent source: `bucketMax === 0` and `totalSamples === 0`.
 * Callers (the predictor) handle this as a degenerate case (no
 * distribution to integrate over).
 *
 * Implication for `predictOutputLufs`: pooled amplitudes are
 * systematically higher than per-sample source amplitudes, so the
 * energy-weighting math biases the predicted-LUFS shift upward.
 * Accepted trade-off (one histogram, two consumers; predictor is a
 * seed only). See `solve.ts` JSDoc for details.
 */
export interface DetectionHistogram {
	readonly buckets: Uint32Array;
	readonly bucketMax: number;
	readonly totalSamples: number;
}

/**
 * Walk a `ChunkBuffer` once and return integrated LUFS, LRA, 4× true
 * peak, the auto pivot/floor stats, and the auto limit threshold from
 * a top-down percentile walk over the post-pivot detection histogram.
 * All accumulators consume the same chunked walk; the result is fed
 * to the iteration loop's anchor / target setup in `iterate.ts`.
 *
 * The detection histogram is built on the POOLED base-rate axis — the
 * same `raw 4× → max-of-4 → SlidingWindowMaxStream(halfWidth)` chain
 * the apply path's `buildBaseRateDetectionCache` feeds into the curve.
 * The caller passes `halfWidth = windowSamplesFromMs(smoothingMs,
 * baseRate)` so this pass and the apply path use the SAME pool
 * geometry. See {@link DetectionHistogram} JSDoc for the rationale
 * (2026-05-13 histogram-axis fix).
 *
 * `limitPercentile` selects which fraction of pooled detection samples
 * falls AT OR BELOW the returned level. With `limitPercentile = 0.995`
 * the top 0.5% of pooled detection samples are above `limitAutoDb` and
 * get brick-walled by the curve's upper branch.
 *
 * Returns `-Infinity` for `integratedLufs` and / or `truePeakDb` on
 * silent input — propagated as-is for the caller to detect and short
 * the pipeline. `lra = 0` is propagated as-is too; iteration handles
 * the short-source case by skipping LRA convergence.
 */
export async function measureSource(buffer: ChunkBuffer, sampleRate: number, limitPercentile: number, halfWidth: number): Promise<SourceMeasurement> {
	const frames = buffer.frames;
	const channelCount = buffer.channels;

	if (frames === 0 || channelCount === 0) {
		return {
			integratedLufs: -Infinity,
			lra: 0,
			truePeakDb: -Infinity,
			pivotAutoDb: Number.POSITIVE_INFINITY,
			floorAutoDb: Number.POSITIVE_INFINITY,
			limitAutoDb: Number.POSITIVE_INFINITY,
			shortTermLufs: [],
			detectionHistogram: { buckets: new Uint32Array(0), bucketMax: 0, totalSamples: 0 },
		};
	}

	const loudness = new LoudnessAccumulator(sampleRate, channelCount);
	const truePeak = new TruePeakAccumulator(sampleRate, channelCount);
	const detectionHistogram = new AmplitudeHistogramAccumulator(HISTOGRAM_BUCKETS);
	// Per-channel BS.1770-4 Annex 1 polyphase FIR upsamplers. Carry
	// 12-tap input history across chunks within THIS measurement pass
	// only. Distinct from walk A's per-attempt detection upsamplers
	// (fresh per attempt) and the stream class's apply-path
	// upsamplers — different signal histories. Replaces the prior
	// Butterworth-IIR `Oversampler` on this path so the detection
	// histogram axis matches BS.1770-4 spec; the IIR underestimated
	// true peak by ~0.5–1 dB vs RX / libebur128.
	const upsamplers: Array<TruePeakUpsampler> = [];

	for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
		upsamplers.push(new TruePeakUpsampler(OVERSAMPLE_FACTOR));
	}

	// Slider runs at BASE rate with the same `halfWidth` the apply
	// path's `buildBaseRateDetectionCache` uses — so the histogram is
	// filled on the exact axis the curve evaluates on. State continues
	// across chunks via one `SlidingWindowMaxStream` instance; the
	// final chunk passes `isFinal=true` to flush the trailing-edge
	// outputs so total emitted == total ingested == base-rate frame
	// count (per the 2026-05-13 histogram-axis fix).
	const slidingWindow = new SlidingWindowMaxStream(halfWidth);

	// Reused scratch buffers:
	//   - `levelsScratch` — 4×-rate raw linked detection signal for one
	//     chunk. Resized only when a chunk grows.
	//   - `baseScratch` — base-rate post-max-of-4 detection signal for
	//     one chunk; fed into the slider. Resized only when a chunk
	//     grows.
	let levelsScratch: Float32Array | null = null;
	let baseScratch: Float32Array | null = null;

	// Rewind read cursor — defensive; the framework leaves the cursor
	// at end-of-buffer after `_process` completes, and measurement is
	// the first reader.
	await buffer.reset();

	let consumedBaseFrames = 0;

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		loudness.push(chunk.samples, chunkFrames);
		truePeak.push(chunk.samples, chunkFrames);

		// Upsample each channel to 4× rate. Per-channel result is a
		// fresh `Float32Array` of length `chunkFrames * factor` from
		// `TruePeakUpsampler.upsample`'s contract.
		const upChannels: Array<Float32Array> = [];

		for (let channelIdx = 0; channelIdx < chunk.samples.length; channelIdx++) {
			const channel = chunk.samples[channelIdx];
			const upsampler = upsamplers[channelIdx];

			if (channel === undefined || upsampler === undefined) {
				upChannels.push(new Float32Array(chunkFrames * OVERSAMPLE_FACTOR));
				continue;
			}

			const slice = channel.length === chunkFrames ? channel : channel.subarray(0, chunkFrames);

			upChannels.push(upsampler.upsample(slice));
		}

		const upChunkLength = chunkFrames * OVERSAMPLE_FACTOR;

		if (levelsScratch === null || levelsScratch.length < upChunkLength) {
			levelsScratch = new Float32Array(upChunkLength);
		}

		if (baseScratch === null || baseScratch.length < chunkFrames) {
			baseScratch = new Float32Array(chunkFrames);
		}

		const levels = levelsScratch;

		// 4×-rate max-linked detection signal:
		// `levels[k] = max_c |upChannels[c][k]|` — the same fill-loop
		// `buildBaseRateDetectionCache` runs.
		for (let upIdx = 0; upIdx < upChunkLength; upIdx++) {
			let max = 0;

			for (let channelIdx = 0; channelIdx < upChannels.length; channelIdx++) {
				const upSample = upChannels[channelIdx]?.[upIdx] ?? 0;
				const absolute = Math.abs(upSample);

				if (absolute > max) max = absolute;
			}

			levels[upIdx] = max;
		}

		// Collapse to base rate by max-of-4 — matches the cache builder
		// in `source-caches.ts:222-237`. Unrolled to four loads + three
		// comparisons per base sample.
		const baseChunk = baseScratch.subarray(0, chunkFrames);

		for (let baseIdx = 0; baseIdx < chunkFrames; baseIdx++) {
			const upOffset = baseIdx * OVERSAMPLE_FACTOR;
			const s0 = levels[upOffset] ?? 0;
			const s1 = levels[upOffset + 1] ?? 0;
			const s2 = levels[upOffset + 2] ?? 0;
			const s3 = levels[upOffset + 3] ?? 0;
			const m01 = s0 > s1 ? s0 : s1;
			const m23 = s2 > s3 ? s2 : s3;

			baseChunk[baseIdx] = m01 > m23 ? m01 : m23;
		}

		consumedBaseFrames += chunkFrames;

		const isLastChunk = chunkFrames < CHUNK_FRAMES;
		const pooled = slidingWindow.push(baseChunk, isLastChunk);

		// Skip empty-output chunks during the slider's leading-edge
		// defer; `AmplitudeHistogramAccumulator.push` does not require
		// a non-empty input but the explicit guard keeps the contract
		// obvious.
		if (pooled.length > 0) {
			detectionHistogram.push([pooled], pooled.length);
		}

		if (isLastChunk) break;
	}

	// `consumedBaseFrames` is used to assert the slider drained the
	// trailing edge — silences the "unused variable" warning while
	// also documenting the invariant intent. (Frames count check is
	// inexpensive and protects against silent slider state bugs.)
	void consumedBaseFrames;

	const loudnessResult = loudness.finalize();
	const truePeakLin = truePeak.finalize();
	const histogramResult = detectionHistogram.finalize();
	const stats = getLraConsideredStats(loudnessResult.shortTerm);

	const limitAutoDb = computeLimitAutoDb(histogramResult.buckets, histogramResult.bucketMax, stats.median, limitPercentile);

	// Sum bucket counts → total sample count. The accumulator does not
	// surface `totalSamples` directly; computing it here from the
	// returned buckets keeps the consumer-facing histogram shape
	// self-contained.
	let totalSamples = 0;

	for (let bucketIdx = 0; bucketIdx < histogramResult.buckets.length; bucketIdx++) {
		totalSamples += histogramResult.buckets[bucketIdx] ?? 0;
	}

	return {
		integratedLufs: loudnessResult.integrated,
		lra: loudnessResult.range,
		truePeakDb: linearToDb(truePeakLin),
		pivotAutoDb: stats.median,
		floorAutoDb: stats.min,
		limitAutoDb,
		shortTermLufs: loudnessResult.shortTerm,
		// Pooled base-rate detection histogram — same axis the apply
		// path's `buildBaseRateDetectionCache` produces, feeding the
		// curve's per-sample `gainDbAt`. `limitAutoDb`'s percentile
		// walk and `predictOutputLufs` both consume this histogram
		// (per the 2026-05-13 histogram-axis fix; the prior raw-4× axis
		// under-estimated typical curve-input levels and produced an
		// over-aggressive `limitAutoDb`).
		detectionHistogram: {
			buckets: histogramResult.buckets,
			bucketMax: histogramResult.bucketMax,
			totalSamples,
		},
	};
}

/**
 * Derive `limitAutoDb` via a top-down percentile walk over the
 * detection histogram. Walks bucket indices from the highest down to
 * the `pivotAutoDb`-aligned start bucket, accumulating sample counts
 * until the cumulative count reaches `totalSamples * (1 -
 * limitPercentile)`. That bucket's centre, converted back to dBFS via
 * {@link linearToDb}, is `limitAutoDb`.
 *
 * Semantics: with `limitPercentile = 0.995` the top 0.5% of detection
 * samples sit above the returned level. Adapts to source distribution
 * shape without conflating "rare tail" with "shape elbow" — a single,
 * unambiguous statistical primitive.
 *
 * Returns `Number.POSITIVE_INFINITY` when the histogram is empty or
 * the post-pivot window holds fewer samples than the percentile
 * target (silent / degenerate sources). Callers fall back to
 * `sourcePeakDb` in that case so the brick-wall branch never engages.
 */
function computeLimitAutoDb(buckets: Uint32Array, bucketMax: number, pivotAutoDb: number, limitPercentile: number): number {
	if (bucketMax === 0) return Number.POSITIVE_INFINITY;

	// Total sample count = sum over all buckets. Bounded by bucket
	// count (1024) — cheap and avoids surfacing `totalSamples` from
	// the accumulator's finalize result just for this call site.
	let totalSamples = 0;

	for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
		totalSamples += buckets[bucketIndex] ?? 0;
	}

	if (totalSamples === 0) return Number.POSITIVE_INFINITY;

	const bucketWidth = bucketMax / buckets.length;
	const effectivePivotDb = Number.isFinite(pivotAutoDb) ? pivotAutoDb : PIVOT_FALLBACK_DB;
	const pivotLinear = dbToLinear(effectivePivotDb);
	const rawStart = Math.floor(pivotLinear / bucketWidth);
	const startBucket = Math.min(buckets.length - 1, Math.max(0, rawStart));
	const targetCount = totalSamples * (1 - limitPercentile);

	let cumulative = 0;
	let limitBucket = -1;

	for (let bucketIndex = buckets.length - 1; bucketIndex >= startBucket; bucketIndex--) {
		cumulative += buckets[bucketIndex] ?? 0;

		if (cumulative >= targetCount) {
			limitBucket = bucketIndex;
			break;
		}
	}

	// Not enough samples in the post-pivot range to reach the
	// percentile threshold — degenerate. Fall back to no-limit
	// sentinel so callers treat the source as having no useful
	// limiting headroom.
	if (limitBucket === -1) return Number.POSITIVE_INFINITY;

	const linearLevel = (limitBucket + 0.5) * bucketWidth;

	return linearToDb(linearLevel);
}
