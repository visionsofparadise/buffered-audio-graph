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

const CHUNK_FRAMES = 44_100;

const HISTOGRAM_BUCKETS = 1024;

const PIVOT_FALLBACK_DB = -40;

export interface SourceMeasurement {
	readonly integratedLufs: number;
	readonly lra: number;
	readonly truePeakDb: number;
	readonly pivotAutoDb: number;
	readonly floorAutoDb: number;
	readonly limitAutoDb: number;
	readonly shortTermLufs: ReadonlyArray<number>;
	readonly detectionHistogram: DetectionHistogram;
}

export interface DetectionHistogram {
	readonly buckets: Uint32Array;
	readonly bucketMax: number;
	readonly totalSamples: number;
}

function emptyMeasurement(): SourceMeasurement {
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

/**
 * Streaming source-measurement accumulator for the loudnessTarget node.
 * Fed per-chunk on the way in (`_buffer`); `finalize()` runs the
 * trailing-edge slider flush, gating stats, percentile walk, and
 * assembly at the barrier. See design-loudness-target for the pooled
 * base-rate detection axis, the accumulator field roles, and the
 * `isFinal` trailing-edge invariant (2026-07-04 comment-migration and
 * barrier-reshape entries).
 */
export class SourceMeasurementAccumulator {
	private readonly limitPercentile: number;
	private readonly loudness: LoudnessAccumulator;
	private readonly truePeak: TruePeakAccumulator;
	private readonly detectionHistogram: AmplitudeHistogramAccumulator;
	private readonly upsamplers: Array<TruePeakUpsampler>;
	private readonly slidingWindow: SlidingWindowMaxStream;
	private levelsScratch: Float32Array | null = null;
	private baseScratch: Float32Array | null = null;
	private pushedFrames = 0;

	constructor(sampleRate: number, channelCount: number, limitPercentile: number, halfWidth: number) {
		this.limitPercentile = limitPercentile;
		this.loudness = new LoudnessAccumulator(sampleRate, channelCount);
		this.truePeak = new TruePeakAccumulator(sampleRate, channelCount);
		this.detectionHistogram = new AmplitudeHistogramAccumulator(HISTOGRAM_BUCKETS);
		this.upsamplers = [];

		for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
			this.upsamplers.push(new TruePeakUpsampler(OVERSAMPLE_FACTOR));
		}

		this.slidingWindow = new SlidingWindowMaxStream(halfWidth);
	}

	push(channels: ReadonlyArray<Float32Array>, frames: number): void {
		if (frames === 0) return;

		this.loudness.push(channels, frames);
		this.truePeak.push(channels, frames);

		const upChannels: Array<Float32Array> = [];

		for (let channelIdx = 0; channelIdx < channels.length; channelIdx++) {
			const channel = channels[channelIdx];
			const upsampler = this.upsamplers[channelIdx];

			if (channel === undefined || upsampler === undefined) {
				upChannels.push(new Float32Array(frames * OVERSAMPLE_FACTOR));
				continue;
			}

			const slice = channel.length === frames ? channel : channel.subarray(0, frames);

			upChannels.push(upsampler.upsample(slice));
		}

		const upChunkLength = frames * OVERSAMPLE_FACTOR;

		if (this.levelsScratch === null || this.levelsScratch.length < upChunkLength) {
			this.levelsScratch = new Float32Array(upChunkLength);
		}

		if (this.baseScratch === null || this.baseScratch.length < frames) {
			this.baseScratch = new Float32Array(frames);
		}

		const levels = this.levelsScratch;

		for (let upIdx = 0; upIdx < upChunkLength; upIdx++) {
			let max = 0;

			for (let channelIdx = 0; channelIdx < upChannels.length; channelIdx++) {
				const upSample = upChannels[channelIdx]?.[upIdx] ?? 0;
				const absolute = Math.abs(upSample);

				if (absolute > max) max = absolute;
			}

			levels[upIdx] = max;
		}

		const baseChunk = this.baseScratch.subarray(0, frames);

		for (let baseIdx = 0; baseIdx < frames; baseIdx++) {
			const upOffset = baseIdx * OVERSAMPLE_FACTOR;
			const s0 = levels[upOffset] ?? 0;
			const s1 = levels[upOffset + 1] ?? 0;
			const s2 = levels[upOffset + 2] ?? 0;
			const s3 = levels[upOffset + 3] ?? 0;
			const m01 = s0 > s1 ? s0 : s1;
			const m23 = s2 > s3 ? s2 : s3;

			baseChunk[baseIdx] = m01 > m23 ? m01 : m23;
		}

		this.pushedFrames += frames;

		const pooled = this.slidingWindow.push(baseChunk, false);

		if (pooled.length > 0) {
			this.detectionHistogram.push([pooled], pooled.length);
		}
	}

	finalize(): SourceMeasurement {
		if (this.pushedFrames === 0) return emptyMeasurement();

		// Trailing-edge flush relocated here from the per-chunk walk: the
		// last chunk is unknowable from a streaming push, so the final
		// `isFinal=true` push drains the slider's deferred trailing
		// outputs before assembly. Empty input, `isFinal=true` — no new
		// frames, only left-edge advances. Histogram totals depend on it.
		const trailing = this.slidingWindow.push(new Float32Array(0), true);

		if (trailing.length > 0) {
			this.detectionHistogram.push([trailing], trailing.length);
		}

		const loudnessResult = this.loudness.finalize();
		const truePeakLin = this.truePeak.finalize();
		const histogramResult = this.detectionHistogram.finalize();
		const stats = getLraConsideredStats(loudnessResult.shortTerm);

		const limitAutoDb = computeLimitAutoDb(histogramResult.buckets, histogramResult.bucketMax, stats.median, this.limitPercentile);

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
			detectionHistogram: {
				buckets: histogramResult.buckets,
				bucketMax: histogramResult.bucketMax,
				totalSamples,
			},
		};
	}
}

/**
 * Walk a `ChunkBuffer` once through a {@link SourceMeasurementAccumulator}
 * and return the assembled {@link SourceMeasurement}. The `LoudnessTargetStream`
 * feeds the accumulator directly from `_buffer` (barrier reshape); this
 * buffer-walking form is retained for the measurement unit tests and as
 * the `_process` fallback when the accumulator was not populated on the
 * way in (e.g. `_process` driven directly). See design-loudness-target
 * for the pooled base-rate detection axis and percentile-walk rationale.
 */
export async function measureSource(buffer: ChunkBuffer, sampleRate: number, limitPercentile: number, halfWidth: number): Promise<SourceMeasurement> {
	const frames = buffer.frames;
	const channelCount = buffer.channels;

	if (frames === 0 || channelCount === 0) return emptyMeasurement();

	const accumulator = new SourceMeasurementAccumulator(sampleRate, channelCount, limitPercentile, halfWidth);

	await buffer.reset();

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		accumulator.push(chunk.samples, chunkFrames);

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	return accumulator.finalize();
}

function computeLimitAutoDb(buckets: Uint32Array, bucketMax: number, pivotAutoDb: number, limitPercentile: number): number {
	if (bucketMax === 0) return Number.POSITIVE_INFINITY;

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

	if (limitBucket === -1) return Number.POSITIVE_INFINITY;

	const linearLevel = (limitBucket + 0.5) * bucketWidth;

	return linearToDb(linearLevel);
}
