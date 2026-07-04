import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type AudioChunk, type ChunkBuffer, type TransformNodeProperties } from "@buffered-audio/core";
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

export class LoudnessTargetStream extends BufferedTransformStream<LoudnessTargetProperties> {
	private winningSmoothedEnvelopeBuffer: ChunkBuffer | null = null;
	private winningB: number | null = null;
	private winningLimitDb: number | null = null;
	private winningPeakGainDb: number | null = null;
	private unbufferCursorsReady = false;

	/**
	 * Source-measurement accumulator fed per-chunk on the way in
	 * (`_buffer`). Lazy-init from the first chunk's rate / channel
	 * count so `halfWidth` matches `buildBaseRateDetectionCache`'s pool.
	 * `undefined` when `_process` is driven without any `_buffer` call
	 * (e.g. the direct-`_process` memory regression path) — `_process`
	 * then falls back to `measureSource(buffer, …)`.
	 */
	private measurementAccumulator?: SourceMeasurementAccumulator;

	public unbufferElapsedMs = 0;

	public learnTimingMs: { sourceMeasurement: number; detection: number; iteration: number } = {
		sourceMeasurement: 0,
		detection: 0,
		iteration: 0,
	};

	override async _buffer(chunk: AudioChunk, buffer: ChunkBuffer): Promise<void> {
		await super._buffer(chunk, buffer);

		const frames = chunk.samples[0]?.length ?? 0;
		const channelCount = chunk.samples.length;

		if (frames === 0 || channelCount === 0) return;

		const tPush0 = Date.now();

		this.measurementAccumulator ??= new SourceMeasurementAccumulator(
			chunk.sampleRate,
			channelCount,
			this.properties.limitPercentile,
			windowSamplesFromMs(this.properties.smoothing, chunk.sampleRate),
		);
		this.measurementAccumulator.push(chunk.samples, frames);

		this.learnTimingMs.sourceMeasurement += Date.now() - tPush0;
	}

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const frames = buffer.frames;
		const channelCount = buffer.channels;
		const sampleRate = buffer.sampleRate ?? this.sampleRate ?? 44100;

		if (frames === 0 || channelCount === 0) return;

		const { targetLufs, targetTp, limitDb: limitDbOverride, limitPercentile, smoothing, tolerance, peakTolerance, maxAttempts } = this.properties;

		const tMeasure0 = Date.now();
		const measurement = this.measurementAccumulator !== undefined
			? this.measurementAccumulator.finalize()
			: await measureSource(buffer, sampleRate, limitPercentile, windowSamplesFromMs(smoothing, sampleRate));

		this.learnTimingMs.sourceMeasurement += Date.now() - tMeasure0;

		const { integratedLufs: sourceLufs, lra: sourceLra, truePeakDb: sourcePeakDb } = measurement;

		if (!Number.isFinite(sourceLufs)) {
			console.log(`[loudness-target] source has no measurable loudness (LUFS=${String(sourceLufs)}); pass-through.`);

			return;
		}

		const userPivot = this.properties.pivot;
		let effectivePivotDb: number;

		if (userPivot !== undefined) {
			effectivePivotDb = userPivot;
		} else if (Number.isFinite(measurement.pivotAutoDb)) {
			effectivePivotDb = measurement.pivotAutoDb;
			console.log(
				`[loudness-target] pivot auto-derived to ${effectivePivotDb.toFixed(2)} dBFS (median(considered LRA blocks))`,
			);
		} else {
			effectivePivotDb = -40;
			console.warn(
				`[loudness-target] pivot auto-derivation produced no considered LRA blocks; falling back to ${effectivePivotDb} dBFS. Supply 'pivot' explicitly for tighter control on short or near-silent sources.`,
			);
		}

		const userFloor = this.properties.floor;
		let effectiveFloorDb: number | null;

		if (userFloor !== undefined) {
			effectiveFloorDb = userFloor;
		} else if (Number.isFinite(measurement.floorAutoDb)) {
			effectiveFloorDb = measurement.floorAutoDb;
			console.log(
				`[loudness-target] floor auto-derived to ${effectiveFloorDb.toFixed(2)} dBFS (min(considered LRA blocks))`,
			);
		} else {
			effectiveFloorDb = null;
		}

		if (effectiveFloorDb !== null && effectiveFloorDb >= effectivePivotDb) {
			const clampedFloorDb = effectivePivotDb - FLOOR_PIVOT_EPSILON_DB;

			console.log(
				`[loudness-target] floor (${effectiveFloorDb.toFixed(2)} dBFS) >= pivot (${effectivePivotDb.toFixed(2)} dBFS); clamping floor to ${clampedFloorDb.toFixed(3)} dBFS (pivot - ${FLOOR_PIVOT_EPSILON_DB} dB).`,
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
		});

		this.learnTimingMs.iteration = Date.now() - tIterate0;
		this.winningSmoothedEnvelopeBuffer = result.bestSmoothedEnvelopeBuffer;
		this.winningB = result.bestB;
		this.winningLimitDb = result.bestLimitDb;
		this.winningPeakGainDb = result.bestPeakGainDb;

		const lastAttempt = result.attempts[result.attempts.length - 1];
		const outputLufsRepr = lastAttempt ? (targetLufs + lastAttempt.lufsErr).toFixed(2) : "n/a";
		const outputLraRepr = lastAttempt ? lastAttempt.outputLra.toFixed(2) : "n/a";
		const lufsDeltaRepr = lastAttempt ? lastAttempt.lufsErr.toFixed(2) : "n/a";
		const outputTruePeakRepr = lastAttempt ? (effectiveTargetTp + lastAttempt.peakErr).toFixed(2) : "n/a";
		const peakDeltaRepr = lastAttempt ? lastAttempt.peakErr.toFixed(2) : "n/a";
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
		const expansionSuffix = expansiveGeometry ? " EXPANSIVE_UPPER_SEGMENT" : "";

		// Per-attempt trajectory dump — diagnostic for iteration
		// trajectory (does the secant converge, oscillate, or stall?).
		for (let attemptIdx = 0; attemptIdx < result.attempts.length; attemptIdx++) {
			const attempt = result.attempts[attemptIdx];

			if (attempt === undefined) continue;
			console.log(
				`[loudness-target] attempt ${(attemptIdx + 1).toString().padStart(2)}: ` +
					`B=${attempt.boost.toFixed(4).padStart(9)} ` +
					`peakGainDb=${attempt.peakGainDb.toFixed(4).padStart(9)} ` +
					`lufsErr=${attempt.lufsErr.toFixed(4).padStart(8)} ` +
					`peakErr=${attempt.peakErr.toFixed(4).padStart(8)} ` +
					`outputLra=${attempt.outputLra.toFixed(4).padStart(7)}`,
			);
		}

		const fmt = (x: number | undefined): string => (x === undefined ? "off" : String(x));

		console.log(
			`[loudness-target] iteration: attempts=${result.attempts.length} ` +
				`converged=${String(result.converged)} ` +
				`seedB=${seedB.toFixed(4)} ` +
				`bestB=${result.bestB.toFixed(4)} bestLimitDb=${bestLimitDbRepr} bestPeakGainDb=${bestPeakGainDbRepr} ` +
				`outputLufs=${outputLufsRepr} (Δ${lufsDeltaRepr}) outputLra=${outputLraRepr} ` +
				`outputTruePeakDb=${outputTruePeakRepr} (Δ${peakDeltaRepr}) ` +
				`targetLufs=${targetLufs.toFixed(2)} ` +
				`targetTp=${targetTp === undefined ? "source" : String(targetTp)} ` +
				`limitDb=${limitDbRepr} limitPercentile=${limitPercentile} ` +
				`sourceLufs=${sourceLufs.toFixed(2)} sourcePeakDb=${sourcePeakDb.toFixed(2)} sourceLra=${sourceLra.toFixed(2)} ` +
				`pivot=${pivotRepr} floor=${floorRepr} ` +
				`smoothing=${smoothing} tolerance=${fmt(tolerance)} peakTolerance=${fmt(peakTolerance)} maxAttempts=${fmt(maxAttempts)}` +
				expansionSuffix,
		);

		if (expansiveGeometry) {
			console.warn(
				`[loudness-target] peakGainDb (${bestPeakGainDbRepr}) > B (${result.bestB.toFixed(4)}); upper segment of curve is expansive between pivot and limit. Brick-wall above limit still caps output at targetTp — note for listening QA.`,
			);
		}
	}

	override async _teardown(): Promise<void> {
		if (this.winningSmoothedEnvelopeBuffer !== null) {
			const total = this.learnTimingMs.sourceMeasurement + this.learnTimingMs.detection + this.learnTimingMs.iteration + this.unbufferElapsedMs;
			const bRepr = this.winningB === null ? "n/a" : this.winningB.toFixed(4);
			const limitDbRepr = this.winningLimitDb === null ? "n/a" : this.winningLimitDb.toFixed(4);
			const peakGainDbRepr = this.winningPeakGainDb === null ? "n/a" : this.winningPeakGainDb.toFixed(4);

			console.log(
				`[loudness-target timing] sourceMeasurement=${this.learnTimingMs.sourceMeasurement}ms ` +
					`detection=${this.learnTimingMs.detection}ms ` +
					`iteration=${this.learnTimingMs.iteration}ms ` +
					`unbufferApply=${this.unbufferElapsedMs}ms ` +
					`total=${total}ms winningB=${bRepr} winningLimitDb=${limitDbRepr} winningPeakGainDb=${peakGainDbRepr}`,
			);
		}

		if (this.winningSmoothedEnvelopeBuffer !== null) {
			await this.winningSmoothedEnvelopeBuffer.close();
			this.winningSmoothedEnvelopeBuffer = null;
		}
	}

	override async _unbuffer(chunk: AudioChunk): Promise<AudioChunk> {
		const envelopeBuffer = this.winningSmoothedEnvelopeBuffer;

		if (envelopeBuffer === null || envelopeBuffer.frames === 0) {
			return chunk;
		}

		const tStart = Date.now();
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) {
			this.unbufferElapsedMs += Date.now() - tStart;

			return chunk;
		}

		if (!this.unbufferCursorsReady) {
			await envelopeBuffer.reset();
			this.unbufferCursorsReady = true;
		}

		const envelopeChunk = await envelopeBuffer.read(chunkFrames);
		const envelopeSlice = envelopeChunk.samples[0];

		if (envelopeSlice?.length !== chunkFrames) {
			throw new Error(
				`loudnessTarget _unbuffer: envelope ChunkBuffer returned ${envelopeSlice?.length ?? 0} samples; expected ${chunkFrames}`,
			);
		}

		const transformed = applyBaseRateChunk({
			chunkSamples: chunk.samples,
			smoothedGain: envelopeSlice,
		});

		this.unbufferElapsedMs += Date.now() - tStart;

		return { samples: transformed, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class LoudnessTargetNode extends TransformNode<LoudnessTargetProperties> {
	static override readonly moduleName = "Loudness Target";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Peak-aware content-adaptive curve fitting (LUFS, true-peak, LRA) via a single combined gain envelope with a peak-respecting two-stage smoother. The upper-arm peak anchor jointly iterates with the body gain to land both LUFS and true-peak targets in one envelope.";
	static override readonly schema = schema;
	static override is(value: unknown): value is LoudnessTargetNode {
		return TransformNode.is(value) && value.type[2] === "loudness-target";
	}

	override readonly type = ["buffered-audio-node", "transform", "loudness-target"] as const;

	constructor(properties: LoudnessTargetProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): LoudnessTargetStream {
		return new LoudnessTargetStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<LoudnessTargetProperties>): LoudnessTargetNode {
		return new LoudnessTargetNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function loudnessTarget(options: { targetLufs?: number; pivot?: number; floor?: number; targetTp?: number; limitPercentile?: number; limitDb?: number; smoothing?: number; tolerance?: number; peakTolerance?: number; maxAttempts?: number; id?: string }): LoudnessTargetNode {
	const parsed = schema.parse(options);

	return new LoudnessTargetNode({ ...parsed, id: options.id });
}
