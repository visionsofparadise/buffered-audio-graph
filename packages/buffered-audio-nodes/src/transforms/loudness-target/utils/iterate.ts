import { BlockBuffer } from "@buffered-audio/core";
import {
	BidirectionalIir,
	LoudnessAccumulator,
	SlidingWindowMinStream,
	TruePeakAccumulator,
	linearToDb,
} from "@buffered-audio/utils";
import { applyBaseRateChunk } from "./apply";
import { CHUNK_FRAMES } from "./constants";
import { type Anchors, gainDbAt } from "./curve";
import { applyBackwardPassOverChunkBuffer, windowSamplesFromMs } from "./envelope";
import {
	assignPeakGainDb,
	bisectBForTargetLufs,
	BOOST_LOWER_BOUND,
	BOOST_UPPER_BOUND,
	predictOutputLufs,
} from "./solve";
import { buildBaseRateDetectionCache } from "./source-caches";
import type { DetectionHistogram } from "./measurement";

const LIMIT_EPSILON_DB = 0.01;

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_TOLERANCE = 0.5;

const GAIN_LUT_MIN_DB = -80;
const GAIN_LUT_MAX_DB = 40;
const GAIN_LUT_STEP_DB = 0.01;
const GAIN_LUT_INV_STEP = 1 / GAIN_LUT_STEP_DB;
const GAIN_LUT_SIZE = Math.round((GAIN_LUT_MAX_DB - GAIN_LUT_MIN_DB) / GAIN_LUT_STEP_DB) + 1;
const GAIN_LUT_STORED_SILENCE_DB = -200;

function buildGainLut(): Float64Array {
	const lut = new Float64Array(GAIN_LUT_SIZE);

	for (let entryIdx = 0; entryIdx < GAIN_LUT_SIZE; entryIdx++) {
		lut[entryIdx] = Math.pow(10, (GAIN_LUT_MIN_DB + entryIdx * GAIN_LUT_STEP_DB) / 20);
	}

	return lut;
}

function gainLutLerp(lut: Float64Array, gainDb: number): number {
	if (gainDb < GAIN_LUT_MIN_DB || gainDb >= GAIN_LUT_MAX_DB) {
		return Math.pow(10, gainDb / 20);
	}

	const pos = (gainDb - GAIN_LUT_MIN_DB) * GAIN_LUT_INV_STEP;
	const lutIdx = pos | 0;
	const frac = pos - lutIdx;
	const lo = lut[lutIdx] ?? 0;
	const hi = lut[lutIdx + 1] ?? 0;

	return lo + (hi - lo) * frac;
}

export interface IterationAttempt {
	boost: number;
	limitDb: number;
	lufsErr: number;
	outputLufs: number;
	outputTruePeakDb: number;
	outputLra: number;
	peakGainDb: number;
	peakErr: number;
	elapsedMs: number;
}

export interface IterateResult {
	bestSmoothedEnvelopeBuffer: BlockBuffer;
	bestB: number;
	bestLimitDb: number;
	bestPeakGainDb: number;
	attempts: ReadonlyArray<IterationAttempt>;
	converged: boolean;
	detectionCacheBuildMs: number;
	winnerOutputLufs: number | null;
	winnerOutputTruePeakDb: number | null;
	winnerOutputLra: number | null;
}

export interface IterateForTargetsArgs {
	buffer: BlockBuffer;
	temporaryDirectory: string;
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
	neverExpand: boolean;
	histogram: DetectionHistogram;
	detectionEnvelope?: BlockBuffer | undefined;
	onAttempt?: (attempt: IterationAttempt, attemptIndex: number) => void;
	progress?: (done: number, total: number) => void;
}

function isLegalAttempt(
	outputLufs: number,
	outputTruePeakDb: number,
	targetLufs: number,
	effectiveTargetTp: number,
): boolean {
	return outputLufs <= targetLufs && outputTruePeakDb <= effectiveTargetTp;
}

export function attemptBeatsWinner(
	candidate: Pick<IterationAttempt, "outputLufs" | "outputTruePeakDb" | "lufsErr">,
	winner: Pick<IterationAttempt, "outputLufs" | "outputTruePeakDb" | "lufsErr"> | undefined,
	targetLufs: number,
	effectiveTargetTp: number,
): boolean {
	if (winner === undefined) return true;

	const candidateLegal = isLegalAttempt(
		candidate.outputLufs,
		candidate.outputTruePeakDb,
		targetLufs,
		effectiveTargetTp,
	);
	const winnerLegal = isLegalAttempt(winner.outputLufs, winner.outputTruePeakDb, targetLufs, effectiveTargetTp);

	if (candidateLegal !== winnerLegal) return candidateLegal;

	if (candidateLegal) return Math.abs(candidate.lufsErr) < Math.abs(winner.lufsErr);

	const candidateHoldsTp = candidate.outputTruePeakDb <= effectiveTargetTp;
	const winnerHoldsTp = winner.outputTruePeakDb <= effectiveTargetTp;

	if (candidateHoldsTp !== winnerHoldsTp) return candidateHoldsTp;

	if (candidateHoldsTp) return candidate.outputLufs < winner.outputLufs;

	if (candidate.outputTruePeakDb !== winner.outputTruePeakDb) {
		return candidate.outputTruePeakDb < winner.outputTruePeakDb;
	}

	return candidate.outputLufs < winner.outputLufs;
}

function nextSearchBoost(
	attempts: ReadonlyArray<IterationAttempt>,
	residualBoost: number,
	targetLufs: number,
): number {
	let highestUnderBoost: number | undefined;
	let lowestOverBoost: number | undefined;

	for (const attempt of attempts) {
		if (attempt.outputLufs <= targetLufs) {
			if (highestUnderBoost === undefined || attempt.boost > highestUnderBoost) {
				highestUnderBoost = attempt.boost;
			}
		} else if (lowestOverBoost === undefined || attempt.boost < lowestOverBoost) {
			lowestOverBoost = attempt.boost;
		}
	}

	if (
		highestUnderBoost !== undefined &&
		lowestOverBoost !== undefined &&
		highestUnderBoost < lowestOverBoost
	) {
		return 0.5 * (highestUnderBoost + lowestOverBoost);
	}

	return residualBoost;
}

export async function iterateForTargets(args: IterateForTargetsArgs): Promise<IterateResult> {
	const {
		buffer,
		temporaryDirectory,
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
		neverExpand,
		histogram,
		onAttempt,
		progress,
	} = args;

	const channelCount = buffer.channels;
	const frames = buffer.frames;

	if (channelCount === 0 || frames === 0) {
		if (args.detectionEnvelope !== undefined) await args.detectionEnvelope.close();

		return {
			bestSmoothedEnvelopeBuffer: new BlockBuffer(temporaryDirectory),
			bestB: 0,
			bestLimitDb: sourcePeakDb,
			bestPeakGainDb: 0,
			attempts: [],
			converged: false,
			detectionCacheBuildMs: 0,
			winnerOutputLufs: null,
			winnerOutputTruePeakDb: null,
			winnerOutputLra: null,
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

	const tpCap = effectiveTargetTp - currentLimit;
	const halfWidth = windowSamplesFromMs(smoothingMs, sampleRate);
	const iir = new BidirectionalIir({ smoothingMs, sampleRate });

	const tCacheBuild0 = Date.now();
	const detectionEnvelope =
		args.detectionEnvelope ??
		(await buildBaseRateDetectionCache({
			buffer,
			temporaryDirectory,
			sampleRate,
			channelCount,
			frames,
			halfWidth,
		}));
	const detectionCacheBuildMs = args.detectionEnvelope !== undefined ? 0 : Date.now() - tCacheBuild0;

	const forwardEnvelopeBuffer = new BlockBuffer(temporaryDirectory);
	const minHeldEnvelopeBuffer = new BlockBuffer(temporaryDirectory);
	const activeBufferA = new BlockBuffer(temporaryDirectory);
	const activeBufferB = new BlockBuffer(temporaryDirectory);

	let activeRef: BlockBuffer = activeBufferA;
	let winningRef: BlockBuffer = activeBufferB;
	let winningPopulated = false;

	try {
		let residual = 0;
		let currentBoost = clampBoost(
			bisectBForTargetLufs({
				sourceLufs,
				targetLufs,
				anchors: { floorDb: anchorBase.floorDb, pivotDb: anchorBase.pivotDb, limitDb: currentLimit },
				histogram,
				tpCap,
				neverExpand,
				residual: 0,
				tolerance,
			}),
		);

		const attempts: Array<IterationAttempt> = [];
		let winningAttempt: IterationAttempt | undefined;
		let bestBoost = currentBoost;
		let bestPeakGainDb = assignPeakGainDb(currentBoost, tpCap, neverExpand);
		let winnerOutputLufs: number | null = null;
		let winnerOutputTruePeakDb: number | null = null;
		let winnerOutputLra: number | null = null;

		const attemptWork = frames * 4;
		const totalWork = maxAttempts * attemptWork;

		for (let attemptIdx = 0; attemptIdx < maxAttempts; attemptIdx++) {
			const attemptBase = attemptIdx * attemptWork;
			const tAttempt0 = Date.now();
			const currentPeakGainDb = assignPeakGainDb(currentBoost, tpCap, neverExpand);
			const anchors: Anchors = {
				floorDb: anchorBase.floorDb,
				pivotDb: anchorBase.pivotDb,
				limitDb: currentLimit,
				B: currentBoost,
				peakGainDb: currentPeakGainDb,
			};
			const predictedLufs = predictOutputLufs(sourceLufs, anchors, histogram);

			await streamCurveAndForwardIir({
				detectionEnvelope,
				anchors,
				iir,
				halfWidth,
				forwardEnvelopeBuffer,
				minHeldEnvelopeBuffer,
				progress: (done) => progress?.(attemptBase + done, totalWork),
			});

			await applyBackwardPassOverChunkBuffer({
				sourceBuffer: forwardEnvelopeBuffer,
				destBuffer: activeRef,
				temporaryDirectory,
				iir,
				chunkSize: CHUNK_FRAMES,
				minHeldBuffer: minHeldEnvelopeBuffer,
				progress: (done) => progress?.(attemptBase + frames + done, totalWork),
			});

			const measured = await measureAttemptOutput({
				source: buffer,
				sampleRate,
				channelCount,
				gSmoothed: activeRef,
				progress: (done) => progress?.(attemptBase + frames * 3 + done, totalWork),
			});

			const lufsErr = measured.outputLufs - targetLufs;
			const peakErr = measured.outputTruePeakDb - effectiveTargetTp;

			const attempt: IterationAttempt = {
				boost: currentBoost,
				limitDb: currentLimit,
				lufsErr,
				outputLufs: measured.outputLufs,
				outputTruePeakDb: measured.outputTruePeakDb,
				outputLra: measured.outputLra,
				peakGainDb: currentPeakGainDb,
				peakErr,
				elapsedMs: Date.now() - tAttempt0,
			};

			attempts.push(attempt);
			onAttempt?.(attempt, attemptIdx);

			if (attemptBeatsWinner(attempt, winningAttempt, targetLufs, effectiveTargetTp)) {
				winningAttempt = attempt;
				bestBoost = currentBoost;
				bestPeakGainDb = currentPeakGainDb;
				winnerOutputLufs = measured.outputLufs;
				winnerOutputTruePeakDb = measured.outputTruePeakDb;
				winnerOutputLra = measured.outputLra;

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

			residual = measured.outputLufs - predictedLufs;

			const residualBoost = bisectBForTargetLufs({
				sourceLufs,
				targetLufs,
				anchors: { floorDb: anchorBase.floorDb, pivotDb: anchorBase.pivotDb, limitDb: currentLimit },
				histogram,
				tpCap,
				neverExpand,
				residual,
				tolerance,
			});
			const nextB = nextSearchBoost(attempts, residualBoost, targetLufs);

			const legalWinnerWithinTolerance =
				winningAttempt !== undefined &&
				isLegalAttempt(
					winningAttempt.outputLufs,
					winningAttempt.outputTruePeakDb,
					targetLufs,
					effectiveTargetTp,
				) &&
				Math.abs(winningAttempt.lufsErr) < tolerance;

			if (
				legalWinnerWithinTolerance ||
				(currentBoost === BOOST_UPPER_BOUND && measured.outputLufs < targetLufs) ||
				(currentBoost === BOOST_LOWER_BOUND && measured.outputLufs > targetLufs) ||
				attemptIdx === maxAttempts - 1
			) {
				break;
			}

			currentBoost = clampBoost(nextB);
		}

		const converged =
			winningAttempt !== undefined &&
			isLegalAttempt(winningAttempt.outputLufs, winningAttempt.outputTruePeakDb, targetLufs, effectiveTargetTp) &&
			Math.abs(winningAttempt.lufsErr) < tolerance;

		return {
			bestSmoothedEnvelopeBuffer: winningRef,
			bestB: bestBoost,
			bestLimitDb: currentLimit,
			bestPeakGainDb,
			attempts,
			converged,
			detectionCacheBuildMs,
			winnerOutputLufs,
			winnerOutputTruePeakDb,
			winnerOutputLra,
		};
	} finally {
		await detectionEnvelope.close();

		await forwardEnvelopeBuffer.close();
		await minHeldEnvelopeBuffer.close();

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

interface StreamCurveAndForwardIirArgs {
	detectionEnvelope: BlockBuffer;
	anchors: Anchors;
	iir: BidirectionalIir;
	halfWidth: number;
	forwardEnvelopeBuffer: BlockBuffer;
	minHeldEnvelopeBuffer: BlockBuffer;
	progress?: (done: number, total: number) => void;
}

async function streamCurveAndForwardIir(args: StreamCurveAndForwardIirArgs): Promise<void> {
	const { detectionEnvelope, anchors, iir, halfWidth, forwardEnvelopeBuffer, minHeldEnvelopeBuffer, progress } = args;
	const totalFrames = detectionEnvelope.frames;

	if (totalFrames === 0) return;

	await detectionEnvelope.reset();

	const forwardState = { value: 0 };
	let forwardSeeded = false;
	const minStream = new SlidingWindowMinStream(halfWidth);

	const gWindowScratch = new Float32Array(CHUNK_FRAMES);

	const gainLut = buildGainLut();

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
			const levelDb = windowChunk[outputIdx] ?? GAIN_LUT_STORED_SILENCE_DB;
			const gainDb = gainDbAt(levelDb, anchors);

			gWindowChunk[outputIdx] = gainLutLerp(gainLut, gainDb);
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
			await minHeldEnvelopeBuffer.write([minHeldChunk], detectionSampleRate, detectionBitDepth);
		}

		progress?.(consumedFrames, totalFrames);

		if (chunkLength < CHUNK_FRAMES) break;
	}

	await forwardEnvelopeBuffer.flushWrites();
	await minHeldEnvelopeBuffer.flushWrites();
}

interface MeasureAttemptArgs {
	source: BlockBuffer;
	sampleRate: number;
	channelCount: number;
	gSmoothed: BlockBuffer;
	progress?: (done: number, total: number) => void;
}

interface MeasureAttemptResult {
	readonly outputLufs: number;
	readonly outputLra: number;
	readonly outputTruePeakDb: number;
}

async function measureAttemptOutput(args: MeasureAttemptArgs): Promise<MeasureAttemptResult> {
	const { source, sampleRate, channelCount, gSmoothed, progress } = args;
	const accumulator = new LoudnessAccumulator(sampleRate, channelCount);
	const truePeakAccumulator = new TruePeakAccumulator(sampleRate, channelCount);

	const applyOutputScratch: Array<Float32Array> = [];

	for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
		applyOutputScratch.push(new Float32Array(CHUNK_FRAMES));
	}

	await source.reset();
	await gSmoothed.reset();

	const totalFrames = source.frames;
	let framesDone = 0;

	for (;;) {
		const sourceChunk = await source.read(CHUNK_FRAMES);
		const chunkFrames = sourceChunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		const envelopeChunk = await gSmoothed.read(chunkFrames);
		const envelopeSlice = envelopeChunk.samples[0];

		if (envelopeSlice?.length !== chunkFrames) {
			throw new Error(
				`measureAttemptOutput: envelope BlockBuffer returned ${envelopeSlice?.length ?? 0} samples; expected ${chunkFrames}`,
			);
		}

		const applyOutputView: Array<Float32Array> = applyOutputScratch.map((slot) => slot.subarray(0, chunkFrames));

		const transformed = applyBaseRateChunk({
			chunkSamples: sourceChunk.samples,
			smoothedGain: envelopeSlice,
			output: applyOutputView,
		});

		accumulator.push(transformed, chunkFrames);
		truePeakAccumulator.push(transformed, chunkFrames);
		framesDone += chunkFrames;
		progress?.(framesDone, totalFrames);

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	const result = accumulator.finalize();
	const truePeakLinear = truePeakAccumulator.finalize();
	const outputTruePeakDb = linearToDb(truePeakLinear);

	return { outputLufs: result.integrated, outputLra: result.range, outputTruePeakDb };
}

function clampBoost(boost: number): number {
	if (!Number.isFinite(boost)) return 0;

	if (boost < BOOST_LOWER_BOUND) return BOOST_LOWER_BOUND;

	if (boost > BOOST_UPPER_BOUND) return BOOST_UPPER_BOUND;

	return boost;
}

export function clampLimit(limitDb: number, pivotDb: number, sourcePeakDb: number): number {
	if (!Number.isFinite(limitDb)) return sourcePeakDb;

	const lower = pivotDb + LIMIT_EPSILON_DB;

	if (lower > sourcePeakDb) return sourcePeakDb;

	if (limitDb < lower) return lower;

	if (limitDb > sourcePeakDb) return sourcePeakDb;

	return limitDb;
}
