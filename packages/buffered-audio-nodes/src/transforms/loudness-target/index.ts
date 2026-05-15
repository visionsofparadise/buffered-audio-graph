import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type AudioChunk, type ChunkBuffer, type TransformNodeProperties } from "@e9g/buffered-audio-nodes-core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { applyBaseRateChunk } from "./utils/apply";
import { windowSamplesFromMs } from "./utils/envelope";
import { clampLimit, iterateForTargets } from "./utils/iterate";
import { measureSource } from "./utils/measurement";
import { predictInitialB } from "./utils/solve";

/**
 * Minimum separation enforced internally between `floor` and `pivot`
 * when auto-derivation (or user combination with auto on the other axis)
 * would land floor at or above pivot. The lower segment of the curve is
 * a linear ramp normalised by `(pivot - floor)` (see `curve.ts`); equal
 * values would divide by zero. 0.01 dB is below the audible JND for
 * level and well under any measurement uncertainty.
 */
const FLOOR_PIVOT_EPSILON_DB = 0.01;

/**
 * Schema for the loudnessTarget node.
 *
 * Fits a source to a `(LUFS, true-peak)` target pair via a single
 * level-indexed gain curve with a peak-respecting smoothed gain
 * envelope. The curve carries an upper-arm peak anchor that gives
 * structural control over `targetTp` in the same envelope that lands
 * LUFS. See design-loudness-target §"Parameters" for the parameter
 * rationale and §"Two-pass node structure" for the stream structure.
 *
 * `pivot` is optional; when undefined the node derives it from
 * `median(considered LRA blocks)` (BS.1770 / EBU R128 two-stage gate)
 * on the pass-1 measurement — see design-loudness-target §"Pivot
 * semantic — lower bound of the gain-riding zone". `floor` is
 * optional; when undefined the curve has no pass-through region and
 * applies uniform body gain B below pivot. The `.refine()` enforces
 * `floor < pivot` only when both are set; per-field `.lt(0)` still
 * constrains each to dB < 0 when supplied.
 *
 * Iteration is 2D joint on `(B, peakGainDb)`. `limitDb` is set ONCE
 * from the measurement (or an explicit override) and is constant across
 * attempts. Initial `B` is seeded by a histogram-based LUFS predictor
 * (per `plan-loudness-target-deterministic` 2026-05-13 revert) so
 * attempt 1 lands close to target and the secant converges in fewer
 * attempts. Initial `peakGainDb` is the closed-form `effectiveTargetTp
 * − limitDb`; per-attempt proportional feedback on TP overshoot moves
 * it from there. LRA falls out as a consequence of the resulting
 * geometry — there is no LRA target axis.
 *
 * `targetTp` is the do-no-harm-default peak axis:
 *   - `targetTp` undefined → `effectiveTargetTp = sourcePeakDb` and
 *     `peakGainDb` collapses to 0; peaks track body lift unchanged.
 *
 * `limitDb` is the limit-anchor override. Default behaviour:
 *   - unset → top-down percentile walk over the source's 4×-rate
 *     detection-envelope histogram (`measureSource`'s `limitAutoDb`),
 *     parameterised by `limitPercentile`.
 *   - set → fix the limit anchor at this value (clamped to the per-
 *     source feasible window inside the iterator).
 *
 * `limitPercentile` selects the brick-wall threshold's statistical
 * quantile on the detection histogram: with default `0.995` the top
 * 0.5 % of detection samples sit above `limitAutoDb` and brick-wall at
 * the target ceiling. Higher values → less limiting (tighter quantile);
 * lower values → more aggressive limiting.
 *
 * `smoothing` is the peak-respecting envelope time constant in ms;
 * collapses `K = W` window-half-width and bidirectional IIR time
 * constant into one user parameter.
 */
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
	/**
	 * BASE-rate peak-respecting smoothed gain envelope produced by the
	 * winning iteration attempt, held as a disk-backed single-channel
	 * `ChunkBuffer` of size `frames` (post the 2026-05-13 base-rate-
	 * downstream rewrite; no `× OVERSAMPLE_FACTOR` factor). The
	 * envelope is read chunk-by-chunk in `_unbuffer` rather than held
	 * as a flat `Float32Array` — keeps RAM at ~10 MB regardless of
	 * source length. `null` when the stream passes through (silent /
	 * sub-block-length source).
	 */
	private winningSmoothedEnvelopeBuffer: ChunkBuffer | null = null;

	/**
	 * Body gain `B` from the winning iteration attempt. `null` when the
	 * stream passes through (no curve was learned). Diagnostic only —
	 * the apply pass uses the materialised envelope, not `B` directly.
	 */
	private winningB: number | null = null;

	/**
	 * Limit anchor `limitDb` used for this source — constant across
	 * iteration attempts. Sourced from `limitDbOverride` when explicit,
	 * else from the percentile-derived `limitAutoDb` on the source's
	 * detection-envelope histogram, else `sourcePeakDb` (no limiting).
	 * `null` when the stream passes through. Diagnostic only.
	 */
	private winningLimitDb: number | null = null;

	/**
	 * `peakGainDb` from the winning attempt — the upper-segment right-
	 * endpoint anchor gain. Starts at the closed-form
	 * `effectiveTargetTp − limitDb` and adjusts via proportional
	 * feedback on observed signed TP error. `null` when the stream
	 * passes through.
	 */
	private winningPeakGainDb: number | null = null;

	/**
	 * Set to `true` by the first `_unbuffer` call so the
	 * `winningSmoothedEnvelopeBuffer`'s read cursor is rewound exactly
	 * once. The envelope is read-only in `_unbuffer` and consumed
	 * forward in chunk-cadence lockstep with upstream chunks; this
	 * lazy-reset pattern keeps the cursor management out of `_setup`.
	 * Post the 2026-05-13 base-rate-downstream rewrite the
	 * upsampled-source cache no longer exists — `_unbuffer` reads
	 * source samples directly from the framework-provided chunk.
	 */
	private unbufferCursorsReady = false;

	/**
	 * Per-chunk wall-clock time spent in `_unbuffer`. Post the
	 * 2026-05-13 base-rate-downstream rewrite, `_unbuffer` is a pure
	 * base-rate multiply per chunk (no upsample, no downsample, no
	 * AA filter — the smoothed envelope is bandlimited far below
	 * base-rate Nyquist, so the multiply introduces no high-frequency
	 * content). Accumulated across all `_unbuffer` calls.
	 */
	public unbufferElapsedMs = 0;

	/**
	 * Wall-clock breakdown of the learn pass. `iteration` is the wall
	 * time spent inside `iterateForTargets`. `detection` stays at 0 for
	 * QA-driver log parity — detection-envelope build cost is folded
	 * into `iteration`.
	 */
	public learnTimingMs: { sourceMeasurement: number; detection: number; iteration: number } = {
		sourceMeasurement: 0,
		detection: 0,
		iteration: 0,
	};

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const frames = buffer.frames;
		const channelCount = buffer.channels;
		const sampleRate = buffer.sampleRate ?? this.sampleRate ?? 44100;

		if (frames === 0 || channelCount === 0) return;

		const { targetLufs, targetTp, limitDb: limitDbOverride, limitPercentile, smoothing, tolerance, peakTolerance, maxAttempts } = this.properties;

		// --- Learn pass ---
		// 1. Source measurement — single chunked walk producing
		//    integrated LUFS, LRA, 4× true peak, the percentile-derived
		//    `limitAutoDb`, and the POOLED base-rate detection-
		//    amplitude histogram (used to seed iteration's initial `B`).
		//    `halfWidth` matches `buildBaseRateDetectionCache`'s pool —
		//    `windowSamplesFromMs(smoothingMs, baseRate)` — so the
		//    histogram lands on the exact axis the curve evaluates on
		//    (per the 2026-05-13 histogram-axis fix).
		const measurementHalfWidth = windowSamplesFromMs(smoothing, sampleRate);
		const tMeasure0 = Date.now();
		const measurement = await measureSource(buffer, sampleRate, limitPercentile, measurementHalfWidth);

		this.learnTimingMs.sourceMeasurement = Date.now() - tMeasure0;

		const { integratedLufs: sourceLufs, lra: sourceLra, truePeakDb: sourcePeakDb } = measurement;

		if (!Number.isFinite(sourceLufs)) {
			// Silent / sub-block-length signal: nothing measurable, no
			// curve to apply. Pass-through.
			console.log(`[loudness-target] source has no measurable loudness (LUFS=${String(sourceLufs)}); pass-through.`);

			return;
		}

		// 1a. Effective pivot — user-supplied if present, else
		//     auto-derived from `median(considered LRA blocks)` carried
		//     on the measurement.
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

		// 1b. Effective floor — user-supplied if present, else
		//     auto-derived from `min(considered LRA blocks)`.
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

		// 1c. Derive the limit anchor that iteration will see, mirroring
		//     `iterateForTargets`'s internal auto-derivation table. We
		//     compute it here too so the histogram-predictor seed
		//     evaluates the predictor at the same `limitDb` iteration
		//     will use — otherwise the seed targets a slightly different
		//     curve geometry.
		const effectiveTargetTp = targetTp ?? sourcePeakDb;
		let solvedLimitDb: number;

		if (limitDbOverride !== undefined) {
			solvedLimitDb = clampLimit(limitDbOverride, effectivePivotDb, sourcePeakDb);
		} else if (Number.isFinite(measurement.limitAutoDb)) {
			solvedLimitDb = clampLimit(measurement.limitAutoDb, effectivePivotDb, sourcePeakDb);
		} else {
			solvedLimitDb = sourcePeakDb;
		}

		// 1d. Initial `B` seed via the histogram-based predictor (per
		//     `plan-loudness-target-deterministic` 2026-05-13 revert).
		//     Pure histogram math — microseconds, no apply pass, no
		//     measurement. The seed is approximate (~0.5-2 LUFS error on
		//     hard material); iteration's secant takes it from there.
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

		// 2. Iteration — 2D joint on `(B, peakGainDb)` over the source
		//    via the restored `iterateForTargets`. The histogram-based
		//    seed (`seedB`) shortens attempt 1's distance to the LUFS
		//    target; iteration's secant + proportional feedback close
		//    the rest. `iterateForTargets` manages its own buffer
		//    lifecycle: detection cache built once, forward/min-held/
		//    activeA/activeB swapped per attempt, winning envelope held
		//    on return.
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
		// Print the wall-clock breakdown before the stream is destroyed
		// so the QA driver can read it from stdout. `iteration` is the
		// wall time spent inside `iterateForTargets` (detection cache
		// build + per-attempt envelope walk + measurement × attempts).
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

		// Post the 2026-05-13 base-rate-downstream rewrite there is no
		// upsampled-source cache to release — `_unbuffer` reads source
		// samples from the framework-provided chunk parameter directly.
		// Only the winning-envelope buffer survives iteration and needs
		// an explicit close here so the backing temp file is released
		// after `_unbuffer` finishes draining.
		if (this.winningSmoothedEnvelopeBuffer !== null) {
			await this.winningSmoothedEnvelopeBuffer.close();
			this.winningSmoothedEnvelopeBuffer = null;
		}
	}

	override async _unbuffer(chunk: AudioChunk): Promise<AudioChunk> {
		const envelopeBuffer = this.winningSmoothedEnvelopeBuffer;

		// Pass-through when no envelope was learned (silent /
		// sub-block-length source). The pass-through bail at the top of
		// `_process` leaves `winningSmoothedEnvelopeBuffer` at `null`,
		// mirrored here for safety. A zero-frame envelope buffer (the
		// iterator's pass-through return shape) also routes to
		// pass-through.
		if (envelopeBuffer === null || envelopeBuffer.frames === 0) {
			return chunk;
		}

		const tStart = Date.now();
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) {
			this.unbufferElapsedMs += Date.now() - tStart;

			return chunk;
		}

		// Rewind the envelope's read cursor on the first `_unbuffer`
		// call. After iteration's `measureAttemptOutput` walks it is
		// positioned at the end of the buffer; `_unbuffer` reads it
		// forward in chunk-cadence lockstep with upstream chunks. Done
		// lazily here rather than eagerly in `_setup` so the reset
		// happens after `_process` (and its iteration) has finished
		// and a stable cursor state exists.
		if (!this.unbufferCursorsReady) {
			await envelopeBuffer.reset();
			this.unbufferCursorsReady = true;
		}

		// Post the 2026-05-13 base-rate-downstream rewrite: the envelope
		// is at base rate, the source samples arrive at base rate via
		// the framework-provided `chunk` parameter, and the apply step
		// is a pure base-rate multiply per sample.
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
	static override readonly moduleName = "LoudnessTarget";
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
