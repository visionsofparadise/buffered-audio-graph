/**
 * Peak-respecting THREE-stage gain envelope for the loudnessTarget
 * node, post `plan-loudness-target-deterministic` Phase 1.
 *
 * Per design-loudness-target §"Smoothing — peak-respecting three-stage
 * envelope".
 *
 * Three stages composed under one user parameter `smoothingMs`:
 *
 *   stage 1 (peak-respecting max-pool on detection):
 *     detectionWindow[n] = max over m in [n - W, n + W] of detection[m]
 *     gPerSample[n]      = 10^(gainDbAt(linearToDb(detectionWindow[n])) / 20)
 *
 *   stage 2 (min-hold on linear gain — brick-wall exactness ceiling):
 *     gMinHold[n] = min over m in [n - W, n + W] of gPerSample[m]
 *
 *   stage 3 (bidirectional IIR on the min-held gain + per-sample clamp):
 *     gForward[n]  = forwardIir(gMinHold)
 *     gBackward[n] = backwardIir(gForward)
 *     gFinal[n]    = min(gBackward[n], gMinHold[n])
 *
 * Min in linear gain = max attenuation. Stage 2's min-hold carries
 * the per-sample brick-wall gain across the same `[n - W, n + W]`
 * window the detection max-pool spans (identical halfWidth on both
 * ends is the brick-wall exactness condition); stage 3's clamp pins
 * the smoothed gain to `gMinHold` so the IIR cannot raise gain above
 * the worst-needed gain anywhere in the window. At the source's
 * true-peak sample, `gFinal = gMinHold = gPerSample` exactly within
 * float32 precision — the per-sample brick-wall invariant.
 *
 * Why three stages: the bidirectional IIR alone averages peak-window
 * gain with neighbouring windows, so peak samples receive the body's
 * averaged gain (envelope-averaging artifact). The peak-respecting
 * max-pool on detection fixes the "what level should drive the
 * curve" half; the min-hold + per-sample clamp on gain fixes the
 * "what gain can the IIR emit" half. Together they make the
 * brick-wall above `limitDb` per-sample exact, which is the
 * precondition for Phase 2's analytical solver to predict TP via the
 * closed form `peakGainDb = targetTp − limitDb`.
 *
 * Stage 1 uses a deque-based monotonic-queue O(N) sliding-window
 * max (https://en.wikipedia.org/wiki/Sliding_window_minimum) via
 * `SlidingWindowMaxStream`; stage 2 uses the mirror primitive
 * `SlidingWindowMinStream` (deque comparison flipped) for the
 * sliding-window min. A naive O(N · W) loop would dominate
 * iteration time for typical sources of 1M+ samples.
 *
 * The streaming three-stage pipeline lives in
 * `iterate.ts:streamCurveAndForwardIir` + `applyBackwardPassOverChunkBuffer`
 * below — `streamCurveAndForwardIir` fuses stages 1, 2, and the
 * forward half of stage 3; this file's `applyBackwardPassOverChunkBuffer`
 * runs the backward half and the per-sample clamp.
 */

import { ChunkBuffer, reverseBuffer } from "@buffered-audio/core";
import { BidirectionalIir, linearToDb, slidingWindowMax } from "@buffered-audio/utils";
import { type Anchors, gainDbAt } from "./curve";

/**
 * Half-width (in samples) of the peak-respecting pool window for a
 * given `smoothingMs`. The window is `[n - W, n + W]` (inclusive on
 * both sides; total span `2W + 1`). With the design's `K = W`
 * coupling, the pool half-width matches the IIR time constant in
 * samples. Floor of 1 sample so smoothingMs at the lower bound
 * still produces a non-degenerate window.
 */
export function windowSamplesFromMs(smoothingMs: number, sampleRate: number): number {
	return Math.max(1, Math.round((smoothingMs * sampleRate) / 1000));
}

/**
 * Peak-respecting smoothed gain envelope (legacy whole-array form).
 *
 * Returns the *linear* gain envelope as a `Float32Array` of the same
 * length as `detection`. The caller multiplies this envelope with
 * each channel's source samples in the apply pass.
 *
 * This is a LEGACY REFERENCE, not the production pipeline. It
 * implements only stages 1 (max-pool on detection) and the
 * bidirectional IIR of stage 3 from the file header's three-stage
 * pipeline — the min-hold (stage 2) and per-sample IIR clamp from
 * `plan-loudness-target-deterministic` Phase 1 are NOT applied here.
 * Output gain at the peak sample is therefore NOT brick-wall exact
 * under this function; it averages with neighbouring window gains
 * exactly the way the production pipeline now avoids. Retained as a
 * regression / equivalence reference for the pre-Phase-1 path; the
 * production stream class wires through
 * `iterate.ts:streamCurveAndForwardIir` +
 * `applyBackwardPassOverChunkBuffer` instead.
 *
 * @param detection - linked detection envelope (`max_c |x[n,c]|`),
 *   linear amplitude, source-rate.
 * @param anchors - curve anchors (floor, pivot, limit, B, peakGainDb).
 * @param smoothingMs - user `smoothing` parameter; range 0.01 .. 200.
 * @param sampleRate - source sample rate (Hz).
 */
export function peakRespectingEnvelope(
	detection: Float32Array,
	anchors: Anchors,
	smoothingMs: number,
	sampleRate: number,
): Float32Array {
	const length = detection.length;

	if (length === 0) return new Float32Array(0);

	const halfWidth = windowSamplesFromMs(smoothingMs, sampleRate);
	const detectionWindow = slidingWindowMax(detection, halfWidth);
	const gWindow = new Float32Array(length);

	for (let sampleIdx = 0; sampleIdx < length; sampleIdx++) {
		const levelDb = linearToDb(detectionWindow[sampleIdx] ?? 0);
		const gainDb = gainDbAt(levelDb, anchors);

		gWindow[sampleIdx] = Math.pow(10, gainDb / 20);
	}

	const iir = new BidirectionalIir({ smoothingMs, sampleRate });

	return iir.applyBidirectional(gWindow);
}

/**
 * Apply the backward HALF of the bidirectional IIR cascade over a
 * source `ChunkBuffer` (the forward-IIR output, in source / forward
 * sample order) into a destination `ChunkBuffer`.
 *
 * Implementation — "reverse twice + forward IIR" trick. The backward
 * IIR is mathematically equivalent to running the forward IIR over
 * the time-reversed signal and then time-reversing the result back.
 * Three streamed passes over the data:
 *
 *   1. `reverseBuffer(sourceBuffer)` materialises a temp buffer
 *      holding the source frames in reverse order.
 *   2. Forward IIR (`applyForwardPass`) is applied chunk-by-chunk
 *      over the reversed source into a second temp buffer. State
 *      is seeded with the first sample of the reversed source — i.e.
 *      the last sample of the original — matching
 *      `applyBackwardPassInPlace`'s init rule.
 *   3. `reverseBuffer` is applied to the IIR output to recover the
 *      natural forward order. When `minHeldBuffer` is omitted, that
 *      reversed output is streamed directly into `destBuffer`. When
 *      `minHeldBuffer` is provided (Phase 1 of `plan-loudness-target-
 *      deterministic`), an additional clamp pass reads the forward-
 *      order IIR output and the min-held envelope in lockstep and
 *      writes `min(g_iir[k], g_min_hold[k])` per sample to
 *      `destBuffer`. The clamp enforces the brick-wall exactness
 *      invariant: `g_final[k] ≤ g_min_hold[k] ≤ g_per_sample[k']`
 *      for all `k' ∈ [k − halfWidth, k + halfWidth]`, so at the
 *      source's true-peak sample the output gain equals the per-sample
 *      target gain exactly (within float32 precision).
 *
 * Caller's responsibility:
 *   - `destBuffer` should be empty or freshly-cleared via `clear()`
 *     before this call. The function appends to `destBuffer`; if it
 *     already holds data, the new output lands after.
 *   - When `minHeldBuffer` is provided, its frame count MUST equal
 *     `sourceBuffer.frames` exactly — both represent the per-sample
 *     gain envelope at base rate and are read in lockstep. A mismatch
 *     would silently mis-clamp the tail; the helper throws on
 *     mismatch.
 *
 * @param sourceBuffer - Holds the forward-IIR output in forward
 *   sample order.
 * @param destBuffer - The smoothed-envelope destination.
 * @param iir - The bidirectional IIR instance (uses
 *   `applyForwardPass` only — both halves share the same
 *   `alphaBidirectional`).
 * @param chunkSize - Iteration stride in samples (single-
 *   channel). Typically `CHUNK_FRAMES` at base rate (per the
 *   2026-05-13 base-rate-downstream rewrite); the helper itself
 *   is rate-agnostic and works at any stride matching the buffer
 *   it walks.
 * @param minHeldBuffer - Optional per-sample min-held gain envelope
 *   (in forward order) for the per-sample clamp `g_final =
 *   min(g_iir, g_min_hold)`. When omitted, the function behaves as
 *   the pre-Phase-1 unclamped backward pass.
 */
export async function applyBackwardPassOverChunkBuffer(args: {
	sourceBuffer: ChunkBuffer;
	destBuffer: ChunkBuffer;
	iir: BidirectionalIir;
	chunkSize: number;
	minHeldBuffer?: ChunkBuffer;
}): Promise<void> {
	const { sourceBuffer, destBuffer, iir, chunkSize, minHeldBuffer } = args;
	const totalFrames = sourceBuffer.frames;

	if (totalFrames === 0) return;
	if (chunkSize <= 0) {
		throw new Error(`applyBackwardPassOverChunkBuffer: chunkSize must be > 0 (got ${chunkSize})`);
	}

	if (minHeldBuffer !== undefined && minHeldBuffer.frames !== totalFrames) {
		throw new Error(
			`applyBackwardPassOverChunkBuffer: minHeldBuffer.frames (${minHeldBuffer.frames}) must equal sourceBuffer.frames (${totalFrames})`,
		);
	}

	const sr = sourceBuffer.sampleRate;
	const bd = sourceBuffer.bitDepth;

	// Phase 1: reverse the source into a temp buffer.
	const reversedSource = await reverseBuffer(sourceBuffer);

	// Phase 2: forward IIR over reversed source → IIR-output buffer.
	const filteredReversed = new ChunkBuffer();
	// Phase 3 splits depending on whether the per-sample clamp is
	// active. Without a min-held buffer we reverse straight into
	// destBuffer. With one, we reverse into a transient forward-order
	// buffer and run a fourth lockstep-clamp pass into destBuffer.
	const iirForwardOrder = minHeldBuffer === undefined ? undefined : new ChunkBuffer();

	try {
		await reversedSource.reset();

		// Seed backward state with the first sample of the reversed source —
		// equivalent to `buffer[buffer.length - 1]` of the original, matching
		// `applyBackwardPassInPlace`'s init rule.
		const seedChunk = await reversedSource.read(1);
		const backwardState = { value: seedChunk.samples[0]?.[0] ?? 0 };

		await reversedSource.reset();

		for (;;) {
			const chunk = await reversedSource.read(chunkSize);
			const data = chunk.samples[0];
			const chunkLength = data?.length ?? 0;

			if (data === undefined || chunkLength === 0) break;

			const filtered = iir.applyForwardPass(data, backwardState);

			await filteredReversed.write([filtered], sr, bd);

			if (chunkLength < chunkSize) break;
		}

		await filteredReversed.flushWrites();

		if (iirForwardOrder === undefined) {
			// Phase 3: reverse the IIR output to natural forward order, written
			// directly into destBuffer.
			await reverseBuffer(filteredReversed, destBuffer);
		} else {
			// Phase 3: reverse the IIR output to natural forward order into a
			// transient buffer (one extra ~10 MB FileChunkBuffer ceiling for
			// the duration of this call), then…
			await reverseBuffer(filteredReversed, iirForwardOrder);
			await iirForwardOrder.flushWrites();

			// Phase 4: stream the IIR output and the min-held envelope in
			// lockstep, write the per-sample min into destBuffer.
			await iirForwardOrder.reset();
			await minHeldBuffer!.reset();

			for (;;) {
				const iirChunk = await iirForwardOrder.read(chunkSize);
				const iirData = iirChunk.samples[0];
				const chunkLength = iirData?.length ?? 0;

				if (iirData === undefined || chunkLength === 0) break;

				const minChunk = await minHeldBuffer!.read(chunkLength);
				const minData = minChunk.samples[0];

				if (minData?.length !== chunkLength) {
					throw new Error(
						`applyBackwardPassOverChunkBuffer: minHeldBuffer returned ${minData?.length ?? 0} samples; expected ${chunkLength}`,
					);
				}

				const clamped = new Float32Array(chunkLength);

				for (let sampleIdx = 0; sampleIdx < chunkLength; sampleIdx++) {
					const iirValue = iirData[sampleIdx] ?? 0;
					const minValue = minData[sampleIdx] ?? 0;

					clamped[sampleIdx] = iirValue < minValue ? iirValue : minValue;
				}

				await destBuffer.write([clamped], sr, bd);

				if (chunkLength < chunkSize) break;
			}

			await destBuffer.flushWrites();
		}
	} finally {
		await reversedSource.close();
		await filteredReversed.close();
		if (iirForwardOrder !== undefined) await iirForwardOrder.close();
	}
}

