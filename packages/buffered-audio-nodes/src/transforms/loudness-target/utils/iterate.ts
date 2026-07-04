import { ChunkBuffer } from "@buffered-audio/core";
import { BidirectionalIir, LoudnessAccumulator, SlidingWindowMinStream, TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";
import { applyBaseRateChunk } from "./apply";
import { type Anchors, gainDbAt } from "./curve";
import { applyBackwardPassOverChunkBuffer, windowSamplesFromMs } from "./envelope";
import { buildBaseRateDetectionCache } from "./source-caches";

// BS.1770-4 inter-sample-peak capture rate; used by measurement.ts + source-caches.ts detection max-pool.
export const OVERSAMPLE_FACTOR = 4;

export const CHUNK_FRAMES = 44_100;

export const BOOST_LOWER_BOUND = -30;
export const BOOST_UPPER_BOUND = 30;

// pivot+ε lower bound avoids (limitDb−pivotDb) div-by-zero in curve.ts:gainDbAt.
const LIMIT_EPSILON_DB = 0.01;

// peakGainDb proportional-feedback damping (QA-tuned 0.8; see design-loudness-target §Iteration).
const PEAK_DAMPING = 0.8;

// peakGainDb attenuation floor (dB).
const PEAK_GAIN_DB_FLOOR = -60;

// Min |slope| for the B-axis secant step (QA-tuned 0.05).
const MIN_SECANT_SLOPE = 0.05;

export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_TOLERANCE = 0.5;

export interface IterationAttempt {
	boost: number;
	limitDb: number;
	lufsErr: number;
	outputLra: number;
	peakGainDb: number;
	peakErr: number;
	elapsedMs: number;
}

export interface IterateResult {
	bestSmoothedEnvelopeBuffer: ChunkBuffer;
	bestB: number;
	bestLimitDb: number;
	bestPeakGainDb: number;
	attempts: ReadonlyArray<IterationAttempt>;
	converged: boolean;
	// 0 when a pre-built detectionEnvelope was supplied.
	detectionCacheBuildMs: number;
}

export interface IterateForTargetsArgs {
	buffer: ChunkBuffer;
	sampleRate: number;
	anchorBase: { floorDb: number | null; pivotDb: number };
	smoothingMs: number;
	targetLufs: number;
	targetTp: number | undefined;
	limitDbOverride?: number | undefined;
	limitAutoDb: number;
	sourceLufs: number;
	sourcePeakDb: number;
	maxAttempts?: number;
	tolerance?: number;
	peakTolerance: number;
	seedB?: number | undefined;
	// Pre-built base-rate detection envelope (ownership transfers; closed by this call). Must be bit-identical to buildBaseRateDetectionCache output for the same buffer/halfWidth.
	detectionEnvelope?: ChunkBuffer | undefined;
}

export async function iterateForTargets(args: IterateForTargetsArgs): Promise<IterateResult> {
	const {
		buffer,
		sampleRate,
		anchorBase,
		smoothingMs,
		targetLufs,
		targetTp,
		limitDbOverride,
		limitAutoDb,
		sourceLufs,
		sourcePeakDb,
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		tolerance = DEFAULT_TOLERANCE,
		peakTolerance,
		seedB,
	} = args;

	const channelCount = buffer.channels;
	const frames = buffer.frames;

	if (channelCount === 0 || frames === 0) {
		if (args.detectionEnvelope !== undefined) await args.detectionEnvelope.close();

		return {
			bestSmoothedEnvelopeBuffer: new ChunkBuffer(),
			bestB: 0,
			bestLimitDb: sourcePeakDb,
			bestPeakGainDb: 0,
			attempts: [],
			converged: false,
			detectionCacheBuildMs: 0,
		};
	}

	const effectiveTargetTp = targetTp ?? sourcePeakDb;
	let currentLimit: number;

	if (limitDbOverride !== undefined) {
		currentLimit = clampLimit(limitDbOverride, anchorBase.pivotDb, sourcePeakDb);
	} else if (Number.isFinite(limitAutoDb)) {
		currentLimit = clampLimit(limitAutoDb, anchorBase.pivotDb, sourcePeakDb);
	} else {
		currentLimit = sourcePeakDb;
	}

	let currentPeakGainDb = effectiveTargetTp - currentLimit;
	const halfWidth = windowSamplesFromMs(smoothingMs, sampleRate);
	const iir = new BidirectionalIir({ smoothingMs, sampleRate });

	const tCacheBuild0 = Date.now();
	const detectionEnvelope = args.detectionEnvelope ?? await buildBaseRateDetectionCache({
		buffer,
		sampleRate,
		channelCount,
		frames,
		halfWidth,
	});
	const detectionCacheBuildMs = args.detectionEnvelope !== undefined ? 0 : Date.now() - tCacheBuild0;

	const forwardEnvelopeBuffer = new ChunkBuffer();
	const minHeldEnvelopeBuffer = new ChunkBuffer();
	// activeRef / winningRef ping-pong: swapped by pointer on a best-attempt update (no envelope copy).
	const activeBufferA = new ChunkBuffer();
	const activeBufferB = new ChunkBuffer();

	let activeRef: ChunkBuffer = activeBufferA;
	let winningRef: ChunkBuffer = activeBufferB;
	let winningPopulated = false;

	try {
		const skipPeak = targetTp === undefined;

		let currentBoost = clampBoost(
			seedB !== undefined && Number.isFinite(seedB) ? seedB : targetLufs - sourceLufs,
		);

		const attempts: Array<IterationAttempt> = [];
		let bestBoost = currentBoost;
		let bestPeakGainDb = currentPeakGainDb;
		let bestScore = Infinity;

		// Infinity seed leaves the first secant call (attempt ≥ 2) uncapped by the asymmetric-damping rule.
		let previousStepMagnitude = Infinity;

		for (let attemptIdx = 0; attemptIdx < maxAttempts; attemptIdx++) {
			const tAttempt0 = Date.now();
			const anchors: Anchors = {
				floorDb: anchorBase.floorDb,
				pivotDb: anchorBase.pivotDb,
				limitDb: currentLimit,
				B: currentBoost,
				peakGainDb: currentPeakGainDb,
			};

			await streamCurveAndForwardIir({
				detectionEnvelope,
				anchors,
				iir,
				halfWidth,
				forwardEnvelopeBuffer,
				minHeldEnvelopeBuffer,
			});

			await applyBackwardPassOverChunkBuffer({
				sourceBuffer: forwardEnvelopeBuffer,
				destBuffer: activeRef,
				iir,
				chunkSize: CHUNK_FRAMES,
				minHeldBuffer: minHeldEnvelopeBuffer,
			});

			const measured = await measureAttemptOutput({
				source: buffer,
				sampleRate,
				channelCount,
				gSmoothed: activeRef,
			});

			const lufsErr = measured.outputLufs - targetLufs;
			const peakErr = measured.outputTruePeakDb - effectiveTargetTp;

			attempts.push({
				boost: currentBoost,
				limitDb: currentLimit,
				lufsErr,
				outputLra: measured.outputLra,
				peakGainDb: currentPeakGainDb,
				peakErr,
				elapsedMs: Date.now() - tAttempt0,
			});

			const peakScoreTerm = skipPeak ? 0 : peakErr * peakErr;
			const score = Math.sqrt(lufsErr * lufsErr + peakScoreTerm);

			if (score < bestScore) {
				bestScore = score;
				bestBoost = currentBoost;
				bestPeakGainDb = currentPeakGainDb;
				const previousActive = activeRef;

				activeRef = winningRef;
				winningRef = previousActive;
				winningPopulated = true;
				await activeRef.clear();
			} else {
				await activeRef.clear();
			}

			await forwardEnvelopeBuffer.clear();
			await minHeldEnvelopeBuffer.clear();

			const matchesToTwoDp =
				Math.round(Math.abs(lufsErr) * 100) === 0
				&& (skipPeak || Math.round(Math.abs(peakErr) * 100) === 0);

			if (matchesToTwoDp) {
				return {
					bestSmoothedEnvelopeBuffer: winningRef,
					bestB: bestBoost,
					bestLimitDb: currentLimit,
					bestPeakGainDb,
					attempts,
					converged: true,
					detectionCacheBuildMs,
				};
			}

			const lufsConverged = Math.abs(lufsErr) < tolerance;
			const peakConverged = skipPeak || Math.abs(peakErr) < peakTolerance;

			if (lufsConverged && peakConverged) {
				return {
					bestSmoothedEnvelopeBuffer: winningRef,
					bestB: bestBoost,
					bestLimitDb: currentLimit,
					bestPeakGainDb,
					attempts,
					converged: true,
					detectionCacheBuildMs,
				};
			}

			if (attemptIdx === maxAttempts - 1) break;

			const next = computeBoostStep(attempts, previousStepMagnitude);

			currentBoost = clampBoost(next.boost);
			previousStepMagnitude = next.stepMagnitude;

			if (!skipPeak && Math.abs(peakErr) > peakTolerance) {
				currentPeakGainDb = Math.max(
					PEAK_GAIN_DB_FLOOR,
					currentPeakGainDb - peakErr * PEAK_DAMPING,
				);
			}
		}

		return {
			bestSmoothedEnvelopeBuffer: winningRef,
			bestB: bestBoost,
			bestLimitDb: currentLimit,
			bestPeakGainDb,
			attempts,
			converged: false,
			detectionCacheBuildMs,
		};
	} finally {
		// detectionEnvelope has no downstream consumer — close on every path. The winner is returned
		// via IterateResult and outlives this call; the losing ping-pong buffer is closed below.
		await detectionEnvelope.close();
		await forwardEnvelopeBuffer.close();
		await minHeldEnvelopeBuffer.close();
		// Pathological branch (no best-attempt update ever fired — impossible for non-zero frames): close both.
		if (!winningPopulated) {
			await activeBufferA.close();
			await activeBufferB.close();
		} else if (winningRef === activeBufferA) {
			await activeBufferB.close();
		} else {
			await activeBufferA.close();
		}
	}
}

export interface StreamCurveAndForwardIirArgs {
	detectionEnvelope: ChunkBuffer;
	anchors: Anchors;
	iir: BidirectionalIir;
	// Must match the detection-cache slider's halfWidth (identical span on both ends is the brick-wall exactness invariant).
	halfWidth: number;
	forwardEnvelopeBuffer: ChunkBuffer;
	minHeldEnvelopeBuffer: ChunkBuffer;
}

export async function streamCurveAndForwardIir(
	args: StreamCurveAndForwardIirArgs,
): Promise<void> {
	const { detectionEnvelope, anchors, iir, halfWidth, forwardEnvelopeBuffer, minHeldEnvelopeBuffer } = args;
	const totalFrames = detectionEnvelope.frames;

	if (totalFrames === 0) return;

	await detectionEnvelope.reset();

	const forwardState = { value: 0 };
	let forwardSeeded = false;
	const minStream = new SlidingWindowMinStream(halfWidth);

	const gWindowScratch = new Float32Array(CHUNK_FRAMES);

	const detectionSampleRate = detectionEnvelope.sampleRate;
	const detectionBitDepth = detectionEnvelope.bitDepth;

	let consumedFrames = 0;

	for (;;) {
		const chunk = await detectionEnvelope.read(CHUNK_FRAMES);
		const windowChunk = chunk.samples[0];
		const chunkLength = windowChunk?.length ?? 0;

		if (windowChunk === undefined || chunkLength === 0) break;

		const gWindowChunk = gWindowScratch.subarray(0, chunkLength);

		for (let outputIdx = 0; outputIdx < chunkLength; outputIdx++) {
			const levelDb = linearToDb(windowChunk[outputIdx] ?? 0);
			const gainDb = gainDbAt(levelDb, anchors);

			gWindowChunk[outputIdx] = Math.pow(10, gainDb / 20);
		}

		consumedFrames += chunkLength;
		const isFinal = consumedFrames >= totalFrames;
		const minHeldChunk = minStream.push(gWindowChunk, isFinal);

		if (minHeldChunk.length > 0) {
			if (!forwardSeeded) {
				forwardState.value = minHeldChunk[0] ?? 0;
				forwardSeeded = true;
			}

			const forwardChunk = iir.applyForwardPass(minHeldChunk, forwardState);

			await forwardEnvelopeBuffer.write([forwardChunk], detectionSampleRate, detectionBitDepth);
			// minHeldChunk is a fresh Float32Array from SlidingWindowMinStream.push; safe to write without copying.
			await minHeldEnvelopeBuffer.write([minHeldChunk], detectionSampleRate, detectionBitDepth);
		}

		if (chunkLength < CHUNK_FRAMES) break;
	}

	await forwardEnvelopeBuffer.flushWrites();
	await minHeldEnvelopeBuffer.flushWrites();
}

export interface MeasureAttemptArgs {
	source: ChunkBuffer;
	sampleRate: number;
	channelCount: number;
	gSmoothed: ChunkBuffer;
}

export interface MeasureAttemptResult {
	readonly outputLufs: number;
	readonly outputLra: number;
	readonly outputTruePeakDb: number;
}

export async function measureAttemptOutput(args: MeasureAttemptArgs): Promise<MeasureAttemptResult> {
	const { source, sampleRate, channelCount, gSmoothed } = args;
	const accumulator = new LoudnessAccumulator(sampleRate, channelCount);
	const truePeakAccumulator = new TruePeakAccumulator(sampleRate, channelCount);

	const applyOutputScratch: Array<Float32Array> = [];

	for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
		applyOutputScratch.push(new Float32Array(CHUNK_FRAMES));
	}

	await source.reset();
	await gSmoothed.reset();

	for (;;) {
		const sourceChunk = await source.read(CHUNK_FRAMES);
		const chunkFrames = sourceChunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		const envelopeChunk = await gSmoothed.read(chunkFrames);
		const envelopeSlice = envelopeChunk.samples[0];

		if (envelopeSlice?.length !== chunkFrames) {
			throw new Error(
				`measureAttemptOutput: envelope ChunkBuffer returned ${envelopeSlice?.length ?? 0} samples; expected ${chunkFrames}`,
			);
		}

		const applyOutputView: Array<Float32Array> = applyOutputScratch.map(
			(slot) => slot.subarray(0, chunkFrames),
		);

		const transformed = applyBaseRateChunk({
			chunkSamples: sourceChunk.samples,
			smoothedGain: envelopeSlice,
			output: applyOutputView,
		});

		accumulator.push(transformed, chunkFrames);
		truePeakAccumulator.push(transformed, chunkFrames);

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	const result = accumulator.finalize();
	const truePeakLinear = truePeakAccumulator.finalize();
	const outputTruePeakDb = linearToDb(truePeakLinear);

	return { outputLufs: result.integrated, outputLra: result.range, outputTruePeakDb };
}

interface BoostStep {
	boost: number;
	stepMagnitude: number;
}

function computeBoostStep(attempts: ReadonlyArray<IterationAttempt>, previousStepMagnitude: number): BoostStep {
	const last = attempts[attempts.length - 1];

	if (last === undefined) return { boost: 0, stepMagnitude: Infinity };

	if (attempts.length === 1) {
		const stepBoost = -last.lufsErr;

		return { boost: last.boost + stepBoost, stepMagnitude: Math.abs(stepBoost) };
	}

	const previous = attempts[attempts.length - 2];

	if (previous === undefined) return { boost: last.boost, stepMagnitude: 0 };

	const deltaBoost = last.boost - previous.boost;
	const deltaLufs = last.lufsErr - previous.lufsErr;
	let slope = deltaBoost === 0 ? 0 : deltaLufs / deltaBoost;

	if (!Number.isFinite(slope) || Math.abs(slope) < MIN_SECANT_SLOPE) {
		const sign = slope < 0 ? -1 : 1;

		slope = sign * MIN_SECANT_SLOPE;
	}

	const stepBoostRaw = -last.lufsErr / slope;
	const signFlipped = last.lufsErr !== 0 && previous.lufsErr !== 0
		&& Math.sign(last.lufsErr) !== Math.sign(previous.lufsErr);
	const magnitudeCap = signFlipped && Number.isFinite(previousStepMagnitude)
		? previousStepMagnitude
		: Infinity;
	const absStep = Math.abs(stepBoostRaw);
	const scale = absStep > magnitudeCap && absStep > 0 ? magnitudeCap / absStep : 1;
	const stepBoost = stepBoostRaw * scale;

	return { boost: last.boost + stepBoost, stepMagnitude: Math.abs(stepBoost) };
}

function clampBoost(boost: number): number {
	if (!Number.isFinite(boost)) return 0;
	if (boost < BOOST_LOWER_BOUND) return BOOST_LOWER_BOUND;
	if (boost > BOOST_UPPER_BOUND) return BOOST_UPPER_BOUND;

	return boost;
}

// pivot+ε lower bound avoids (limitDb−pivotDb) div-by-zero in curve.ts:gainDbAt.
export function clampLimit(limitDb: number, pivotDb: number, sourcePeakDb: number): number {
	if (!Number.isFinite(limitDb)) return sourcePeakDb;

	const lower = pivotDb + LIMIT_EPSILON_DB;

	if (lower > sourcePeakDb) return sourcePeakDb;
	if (limitDb < lower) return lower;
	if (limitDb > sourcePeakDb) return sourcePeakDb;

	return limitDb;
}
