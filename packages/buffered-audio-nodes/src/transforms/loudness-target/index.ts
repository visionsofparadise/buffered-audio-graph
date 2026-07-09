import { z } from "zod";
import { BufferedTransformStream, BlockBuffer, createProgressGate, TransformNode, WHOLE_FILE, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { applyBaseRateChunk } from "./utils/apply";
import { windowSamplesFromMs } from "./utils/envelope";
import { clampLimit, iterateForTargets } from "./utils/iterate";
import { measureSource, SourceMeasurementAccumulator } from "./utils/measurement";
import { predictInitialB } from "./utils/solve";

const FLOOR_PIVOT_EPSILON_DB = 0.01;

export const schema = z.object({
	targetLufs:    z.number().min(-50).max(0).multipleOf(0.1).default(-16).describe("Target integrated loudness (LUFS)"),
	pivot:         z.number().lt(0).optional().describe("Body anchor (dB). Default: median(considered LRA blocks) from BS.1770 LRA gating in pass 1."),
	floor:         z.number().lt(0).optional().describe("Silence threshold (dB). Default: min(considered LRA blocks); no floor when no blocks survive gating."),
	limitPercentile: z.number().min(0.5).max(1.0).default(0.995).describe("Top-1−p fraction of detection samples to brick-wall. Default 0.995 brick-walls the top 0.5%."),
	limitDb:       z.number().lt(0).optional().describe("Limit-anchor override (dB). Default: auto-derived from quantile(detection histogram, limitPercentile). Set explicitly to fix the limit anchor."),
	maxAttempts:   z.number().int().min(1).default(10).describe("Hard cap on iteration attempts."),
	targetTp:      z.number().lt(0).optional().describe("True-peak target (dBTP). Default: source true peak (peaks unchanged)."),
	smoothing:     z.number().min(0.01).max(200).default(1).describe("Peak-respecting envelope time constant (ms)."),
	tolerance:     z.number().gt(0).default(0.5).describe("Iteration exit threshold (LUFS dB)."),
	peakTolerance: z.number().gt(0).default(0.1).describe("One-sided iteration exit threshold for output true-peak overshoot (dBTP; ceiling — undershoot ignored)."),
}).refine(
	({ floor, pivot }) => floor === undefined || pivot === undefined || floor < pivot,
	{ message: "loudnessTarget requires floor < pivot when floor is set" },
);

export interface LoudnessTargetProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class LoudnessTargetStream extends BufferedTransformStream<LoudnessTargetNode> {
	override blockSize = WHOLE_FILE;

	private winningSmoothedEnvelopeBuffer: BlockBuffer | null = null;
	private winningB: number | null = null;
	private winningLimitDb: number | null = null;
	private winningPeakGainDb: number | null = null;

	private measurementAccumulator?: SourceMeasurementAccumulator;
	private capturedDetectionEnvelope: BlockBuffer | null = null;

	public unbufferElapsedMs = 0;

	public learnTimingMs: { sourceMeasurement: number; detection: number; iteration: number } = {
		sourceMeasurement: 0,
		detection: 0,
		iteration: 0,
	};

	override async _prepare(block: Block): Promise<Block> {
		const frames = block.samples[0]?.length ?? 0;
		const channelCount = block.samples.length;

		if (frames === 0 || channelCount === 0) return block;

		const tPush0 = Date.now();

		if (this.measurementAccumulator === undefined) {
			this.capturedDetectionEnvelope = new BlockBuffer();
			this.measurementAccumulator = new SourceMeasurementAccumulator(
				block.sampleRate,
				channelCount,
				this.properties.limitPercentile,
				windowSamplesFromMs(this.properties.smoothing, block.sampleRate),
				this.capturedDetectionEnvelope,
				block.bitDepth,
			);
		}

		await this.measurementAccumulator.push(block.samples, frames);

		this.learnTimingMs.sourceMeasurement += Date.now() - tPush0;

		return block;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		await this.finalize(buffered);

		yield* this.emitApplied(buffered);
	}

	private async finalize(buffer: BlockBuffer): Promise<void> {
		const frames = buffer.frames;
		const channelCount = buffer.channels;
		const sampleRate = buffer.sampleRate ?? this.sampleRate ?? 44100;

		if (frames === 0 || channelCount === 0) return;

		const { targetLufs, targetTp, limitDb: limitDbOverride, limitPercentile, smoothing, tolerance, peakTolerance, maxAttempts } = this.properties;

		const tMeasure0 = Date.now();
		const measurement = this.measurementAccumulator !== undefined
			? await this.measurementAccumulator.finalize()
			: await measureSource(buffer, sampleRate, limitPercentile, windowSamplesFromMs(smoothing, sampleRate));

		this.learnTimingMs.sourceMeasurement += Date.now() - tMeasure0;

		// Ownership moves out of the field here: iterateForTargets closes whatever it is handed; the
		// frames-mismatch / no-loudness paths close locally.
		const capturedDetectionEnvelope = this.capturedDetectionEnvelope;

		this.capturedDetectionEnvelope = null;

		const detectionEnvelope = capturedDetectionEnvelope !== null && capturedDetectionEnvelope.frames === frames
			? capturedDetectionEnvelope
			: undefined;

		if (detectionEnvelope === undefined && capturedDetectionEnvelope !== null) {
			this.log(
				"captured detection envelope frames mismatch; rebuilding at barrier",
				{ capturedFrames: capturedDetectionEnvelope.frames, bufferFrames: frames },
				"warn",
			);
			await capturedDetectionEnvelope.close();
		}

		const { integratedLufs: sourceLufs, lra: sourceLra, truePeakDb: sourcePeakDb } = measurement;

		if (!Number.isFinite(sourceLufs)) {
			if (detectionEnvelope !== undefined) await detectionEnvelope.close();

			this.log("source has no measurable loudness; pass-through", { sourceLufs });

			return;
		}

		const userPivot = this.properties.pivot;
		let effectivePivotDb: number;

		if (userPivot !== undefined) {
			effectivePivotDb = userPivot;
		} else if (Number.isFinite(measurement.pivotAutoDb)) {
			effectivePivotDb = measurement.pivotAutoDb;
			this.log("pivot auto-derived (median(considered LRA blocks))", { pivotDb: effectivePivotDb });
		} else {
			effectivePivotDb = -40;
			this.log(
				"pivot auto-derivation produced no considered LRA blocks; falling back. Supply 'pivot' explicitly for tighter control on short or near-silent sources.",
				{ fallbackPivotDb: effectivePivotDb },
				"warn",
			);
		}

		const userFloor = this.properties.floor;
		let effectiveFloorDb: number | null;

		if (userFloor !== undefined) {
			effectiveFloorDb = userFloor;
		} else if (Number.isFinite(measurement.floorAutoDb)) {
			effectiveFloorDb = measurement.floorAutoDb;
			this.log("floor auto-derived (min(considered LRA blocks))", { floorDb: effectiveFloorDb });
		} else {
			effectiveFloorDb = null;
		}

		if (effectiveFloorDb !== null && effectiveFloorDb >= effectivePivotDb) {
			const clampedFloorDb = effectivePivotDb - FLOOR_PIVOT_EPSILON_DB;

			this.log(
				"floor >= pivot; clamping floor to (pivot - epsilon)",
				{ floorDb: effectiveFloorDb, pivotDb: effectivePivotDb, clampedFloorDb, epsilonDb: FLOOR_PIVOT_EPSILON_DB },
			);
			effectiveFloorDb = clampedFloorDb;
		}

		const effectiveTargetTp = targetTp ?? sourcePeakDb;
		let solvedLimitDb: number;

		if (limitDbOverride !== undefined) {
			solvedLimitDb = clampLimit(limitDbOverride, effectivePivotDb, sourcePeakDb);
		} else if (Number.isFinite(measurement.limitAutoDb)) {
			solvedLimitDb = clampLimit(measurement.limitAutoDb, effectivePivotDb, sourcePeakDb);
		} else {
			solvedLimitDb = sourcePeakDb;
		}

		const brickWallDormant = sourcePeakDb <= solvedLimitDb;
		const closedFormPeakGainDb = effectiveTargetTp - solvedLimitDb;
		const seedB = predictInitialB({
			sourceLufs,
			targetLufs,
			anchors: { floorDb: effectiveFloorDb, pivotDb: effectivePivotDb, limitDb: solvedLimitDb },
			histogram: measurement.detectionHistogram,
			brickWallDormant,
			closedFormPeakGainDb,
			tolerance,
		});

		const tIterate0 = Date.now();
		const attemptGate = createProgressGate(maxAttempts);
		const result = await iterateForTargets({
			buffer,
			sampleRate,
			anchorBase: { floorDb: effectiveFloorDb, pivotDb: effectivePivotDb },
			smoothingMs: smoothing,
			targetLufs,
			targetTp,
			limitDbOverride,
			limitAutoDb: measurement.limitAutoDb,
			sourceLufs,
			sourcePeakDb,
			maxAttempts,
			tolerance,
			peakTolerance,
			seedB,
			detectionEnvelope,
			onAttempt: (attempt, attemptIndex) => {
				this.log("attempt", {
					attempt: attemptIndex + 1,
					B: attempt.boost,
					peakGainDb: attempt.peakGainDb,
					lufsErr: attempt.lufsErr,
					peakErr: attempt.peakErr,
					outputLra: attempt.outputLra,
					elapsedMs: attempt.elapsedMs,
				});

				if (attemptGate(attemptIndex + 1, Date.now())) this.emitProgress("process", attemptIndex + 1, maxAttempts);
			},
		});

		this.learnTimingMs.iteration = Date.now() - tIterate0;
		this.learnTimingMs.detection = result.detectionCacheBuildMs;
		this.winningSmoothedEnvelopeBuffer = result.bestSmoothedEnvelopeBuffer;
		this.winningB = result.bestB;
		this.winningLimitDb = result.bestLimitDb;
		this.winningPeakGainDb = result.bestPeakGainDb;

		// Headline numbers are the winning attempt's exact BS.1770 measurement (the applied envelope is the
		// winner's), not the last attempt.
		const outputLufsRepr = result.winnerOutputLufs !== null ? result.winnerOutputLufs.toFixed(2) : "n/a";
		const outputLraRepr = result.winnerOutputLra !== null ? result.winnerOutputLra.toFixed(2) : "n/a";
		const lufsDeltaRepr = result.winnerOutputLufs !== null ? (result.winnerOutputLufs - targetLufs).toFixed(2) : "n/a";
		const outputTruePeakRepr = result.winnerOutputTruePeakDb !== null ? result.winnerOutputTruePeakDb.toFixed(2) : "n/a";
		const peakDeltaRepr = result.winnerOutputTruePeakDb !== null ? (result.winnerOutputTruePeakDb - effectiveTargetTp).toFixed(2) : "n/a";
		const bestPeakGainDbRepr = result.bestPeakGainDb.toFixed(4);
		const bestLimitDbRepr = result.bestLimitDb.toFixed(4);
		const pivotRepr = userPivot === undefined
			? `${effectivePivotDb.toFixed(2)} (auto)`
			: String(userPivot);
		const floorRepr = userFloor !== undefined
			? String(userFloor)
			: effectiveFloorDb === null
				? "none"
				: `${effectiveFloorDb.toFixed(2)} (auto)`;
		let limitDbSource: "user" | "auto" | "none";

		if (limitDbOverride !== undefined) {
			limitDbSource = "user";
		} else if (Number.isFinite(measurement.limitAutoDb)) {
			limitDbSource = "auto";
		} else {
			limitDbSource = "none";
		}

		const limitDbRepr = `${bestLimitDbRepr} (${limitDbSource})`;
		const expansiveGeometry = result.bestPeakGainDb > result.bestB;

		const fmt = (x: number | undefined): string => (x === undefined ? "off" : String(x));

		this.log("iteration", {
			attempts: result.attempts.length,
			converged: result.converged,
			seedB,
			bestB: result.bestB,
			bestLimitDb: bestLimitDbRepr,
			bestPeakGainDb: bestPeakGainDbRepr,
			outputLufs: outputLufsRepr,
			lufsDelta: lufsDeltaRepr,
			outputLra: outputLraRepr,
			outputTruePeakDb: outputTruePeakRepr,
			peakDelta: peakDeltaRepr,
			targetLufs,
			targetTp: targetTp === undefined ? "source" : String(targetTp),
			limitDb: limitDbRepr,
			limitPercentile,
			sourceLufs,
			sourcePeakDb,
			sourceLra,
			pivot: pivotRepr,
			floor: floorRepr,
			smoothing,
			tolerance: fmt(tolerance),
			peakTolerance: fmt(peakTolerance),
			maxAttempts: fmt(maxAttempts),
			expansiveUpperSegment: expansiveGeometry,
		});

		if (expansiveGeometry) {
			this.log(
				"peakGainDb > B; upper segment of curve is expansive between pivot and limit. Brick-wall above limit still caps output at targetTp — note for listening QA.",
				{ peakGainDb: bestPeakGainDbRepr, B: result.bestB },
				"warn",
			);
		}
	}

	override async _destroy(): Promise<void> {
		if (this.winningSmoothedEnvelopeBuffer !== null) {
			const total = this.learnTimingMs.sourceMeasurement + this.learnTimingMs.detection + this.learnTimingMs.iteration + this.unbufferElapsedMs;
			const bRepr = this.winningB === null ? "n/a" : this.winningB.toFixed(4);
			const limitDbRepr = this.winningLimitDb === null ? "n/a" : this.winningLimitDb.toFixed(4);
			const peakGainDbRepr = this.winningPeakGainDb === null ? "n/a" : this.winningPeakGainDb.toFixed(4);

			this.log("timing", {
				sourceMeasurementMs: this.learnTimingMs.sourceMeasurement,
				detectionMs: this.learnTimingMs.detection,
				iterationMs: this.learnTimingMs.iteration,
				unbufferApplyMs: this.unbufferElapsedMs,
				totalMs: total,
				winningB: bRepr,
				winningLimitDb: limitDbRepr,
				winningPeakGainDb: peakGainDbRepr,
			});
		}

		if (this.winningSmoothedEnvelopeBuffer !== null) {
			await this.winningSmoothedEnvelopeBuffer.close();
			this.winningSmoothedEnvelopeBuffer = null;
		}

		// Non-null only when finalize never ran (upstream error); the normal path hands ownership to iterateForTargets.
		if (this.capturedDetectionEnvelope !== null) {
			await this.capturedDetectionEnvelope.close();
			this.capturedDetectionEnvelope = null;
		}
	}

	private async *emitApplied(buffered: BlockBuffer): AsyncGenerator<Block> {
		const envelopeBuffer = this.winningSmoothedEnvelopeBuffer;

		await buffered.reset();

		if (envelopeBuffer === null || envelopeBuffer.frames === 0) {
			yield* buffered.iterate(44100);

			return;
		}

		await envelopeBuffer.reset();

		for await (const block of buffered.iterate(44100)) {
			const tStart = Date.now();
			const chunkFrames = block.samples[0]?.length ?? 0;

			if (chunkFrames === 0) {
				this.unbufferElapsedMs += Date.now() - tStart;

				yield block;

				continue;
			}

			const envelopeChunk = await envelopeBuffer.read(chunkFrames);
			const envelopeSlice = envelopeChunk.samples[0];

			if (envelopeSlice?.length !== chunkFrames) {
				throw new Error(
					`loudnessTarget emitApplied: envelope BlockBuffer returned ${envelopeSlice?.length ?? 0} samples; expected ${chunkFrames}`,
				);
			}

			const transformed = applyBaseRateChunk({
				chunkSamples: block.samples,
				smoothedGain: envelopeSlice,
			});

			this.unbufferElapsedMs += Date.now() - tStart;

			yield { samples: transformed, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth };
		}
	}
}

export class LoudnessTargetNode extends TransformNode<LoudnessTargetProperties> {
	static override readonly nodeName = "Loudness Target";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Peak-aware content-adaptive curve fitting (LUFS, true-peak, LRA) via a single combined gain envelope with a peak-respecting two-stage smoother. The upper-arm peak anchor jointly iterates with the body gain to land both LUFS and true-peak targets in one envelope.";
	static override readonly schema = schema;
	static override readonly Stream = LoudnessTargetStream;
}

export function loudnessTarget(options: { targetLufs?: number; pivot?: number; floor?: number; targetTp?: number; limitPercentile?: number; limitDb?: number; smoothing?: number; tolerance?: number; peakTolerance?: number; maxAttempts?: number; id?: string }): LoudnessTargetNode {
	return new LoudnessTargetNode(options);
}
