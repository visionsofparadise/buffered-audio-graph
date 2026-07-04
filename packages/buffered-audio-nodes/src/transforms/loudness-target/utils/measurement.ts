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

export class SourceMeasurementAccumulator {
	private readonly limitPercentile: number;
	private readonly sampleRate: number;
	private readonly loudness: LoudnessAccumulator;
	private readonly truePeak: TruePeakAccumulator;
	private readonly detectionHistogram: AmplitudeHistogramAccumulator;
	private readonly upsamplers: Array<TruePeakUpsampler>;
	private readonly slidingWindow: SlidingWindowMaxStream;
	private readonly detectionEnvelope: ChunkBuffer | null;
	private readonly kwSquaredBuffer: ChunkBuffer | null;
	private readonly d4maxBuffer: ChunkBuffer | null;
	private readonly persistBitDepth: number | undefined;
	private levelsScratch: Float32Array | null = null;
	private baseScratch: Float32Array | null = null;
	private kwSquaredScratch: Float32Array | null = null;
	private readonly upsampleScratches: Array<Float32Array> = [];
	private pushedFrames = 0;

	constructor(
		sampleRate: number,
		channelCount: number,
		limitPercentile: number,
		halfWidth: number,
		detectionEnvelope: ChunkBuffer | null = null,
		persistBitDepth?: number,
		proxyCaches?: { kwSquared: ChunkBuffer; d4max: ChunkBuffer },
	) {
		this.limitPercentile = limitPercentile;
		this.sampleRate = sampleRate;
		this.loudness = new LoudnessAccumulator(sampleRate, channelCount);
		this.truePeak = new TruePeakAccumulator(sampleRate, channelCount);
		this.detectionHistogram = new AmplitudeHistogramAccumulator(HISTOGRAM_BUCKETS);
		this.upsamplers = [];

		for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
			this.upsamplers.push(new TruePeakUpsampler(OVERSAMPLE_FACTOR));
		}

		this.slidingWindow = new SlidingWindowMaxStream(halfWidth);
		this.detectionEnvelope = detectionEnvelope;
		this.kwSquaredBuffer = proxyCaches?.kwSquared ?? null;
		this.d4maxBuffer = proxyCaches?.d4max ?? null;
		this.persistBitDepth = persistBitDepth;
	}

	async push(channels: ReadonlyArray<Float32Array>, frames: number): Promise<void> {
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
			let scratch = this.upsampleScratches[channelIdx];

			if (scratch === undefined || scratch.length < frames * OVERSAMPLE_FACTOR) {
				scratch = new Float32Array(frames * OVERSAMPLE_FACTOR);
				this.upsampleScratches[channelIdx] = scratch;
			}

			upChannels.push(upsampler.upsample(slice, scratch));
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

		// kw²[n] (per-frame K-weighted channel-summed square) and d4max[n] (= baseChunk, pre-pool inter-sample
		// peak) are the loudnessTarget proxy-measurement caches. Both are per-frame (full `frames`, no slider
		// deferral), so their totals equal the source frame count without a trailing flush.
		if (this.d4maxBuffer !== null) {
			await this.d4maxBuffer.write([baseChunk], this.sampleRate, this.persistBitDepth);
		}

		if (this.kwSquaredBuffer !== null) {
			if (this.kwSquaredScratch === null || this.kwSquaredScratch.length < frames) {
				this.kwSquaredScratch = new Float32Array(frames);
			}

			const kwSquared = this.loudness.peekLastSquaredSums();
			const kwF32 = this.kwSquaredScratch.subarray(0, frames);

			for (let frameIdx = 0; frameIdx < frames; frameIdx++) kwF32[frameIdx] = kwSquared[frameIdx] ?? 0;

			await this.kwSquaredBuffer.write([kwF32], this.sampleRate, this.persistBitDepth);
		}

		const pooled = this.slidingWindow.push(baseChunk, false);

		if (pooled.length > 0) {
			this.detectionHistogram.push([pooled], pooled.length);

			if (this.detectionEnvelope !== null) {
				await this.detectionEnvelope.write([pooled], this.sampleRate, this.persistBitDepth);
			}
		}
	}

	async finalize(): Promise<SourceMeasurement> {
		if (this.pushedFrames === 0) return emptyMeasurement();

		// Final isFinal=true push drains the slider's deferred trailing outputs before assembly; histogram totals depend on it.
		const trailing = this.slidingWindow.push(new Float32Array(0), true);

		if (trailing.length > 0) {
			this.detectionHistogram.push([trailing], trailing.length);

			if (this.detectionEnvelope !== null) {
				await this.detectionEnvelope.write([trailing], this.sampleRate, this.persistBitDepth);
			}
		}

		if (this.detectionEnvelope !== null) {
			await this.detectionEnvelope.flushWrites();
		}

		if (this.d4maxBuffer !== null) await this.d4maxBuffer.flushWrites();
		if (this.kwSquaredBuffer !== null) await this.kwSquaredBuffer.flushWrites();

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

// Retained: measurement.unit.test.ts caller + _process fallback when the accumulator was not populated on the way in.
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

		await accumulator.push(chunk.samples, chunkFrames);

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	return await accumulator.finalize();
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
