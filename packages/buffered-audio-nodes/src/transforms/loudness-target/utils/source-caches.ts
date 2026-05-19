/**
 * Cache-build helper for the loudnessTarget iteration loop.
 *
 * Per `plan-loudness-target-base-rate-downstream.md` (the 2026-05-13
 * base-rate-downstream rewrite, which partially supersedes the
 * 2026-05-12 stream-caching design): the only signal that
 * STRUCTURALLY needs 4× rate is the detection envelope, because the
 * max-pool across upsampled samples is what captures inter-sample
 * peaks for the curve. Everything downstream of detection (Walk A's
 * forward IIR, the backward pass, Walk B's apply, `_unbuffer`'s
 * apply) operates on a smoothed gain envelope that is bandlimited far
 * below base-rate Nyquist — so storing/applying at base rate loses
 * nothing, and the `source × envelope` multiply produces no
 * meaningful high-frequency content (no AA filter needed). User has
 * empirically validated this.
 *
 * Concretely, this builder now produces exactly one cache:
 *
 *   - A base-rate, single-channel detection envelope `ChunkBuffer`,
 *     `frames === source.frames`. Built by streaming the source
 *     ChunkBuffer at base rate, upsampling each chunk inline to 4×
 *     for the max-pool, collapsing to base rate by max-of-4, and
 *     pushing the base-rate chunk through `SlidingWindowMaxStream`
 *     instantiated at base rate (with a halved `halfWidth` so the
 *     window covers the same milliseconds as the prior 4× slider).
 *
 * The upsampled-source cache that the 2026-05-12 design produced
 * (sized `frames × OVERSAMPLE_FACTOR × channelCount` — ~3.3 GB on a
 * 71-min stereo source) is GONE — no source cache exists at all.
 * Iteration walks (Phase 2 of the plan) read the source `ChunkBuffer`
 * directly at base rate.
 *
 * The 4× upsampled chunks produced inline here are NOT retained: each
 * is consumed by the max-pool fill loop and dropped before the next
 * chunk is read. Memory ceiling for upsampled data is one chunk
 * (`CHUNK_FRAMES × OVERSAMPLE_FACTOR × channelCount × 4 bytes` —
 * ~5.6 MB for a stereo 44.1 kHz chunk), not source length.
 *
 * The returned `ChunkBuffer` lazily spills to disk above the 10 MB
 * scratch threshold so the in-memory footprint stays bounded
 * regardless of source length. The caller owns the lifecycle — call
 * `close()` when it goes out of use.
 *
 * The `SlidingWindowMaxStream` runs ONCE during cache build with
 * state continuity across chunks. Its leading-edge defer of
 * `halfWidth` samples is owned by this builder so callers see a
 * fully-populated detection buffer of exact length `frames` (base
 * rate). The final input chunk is signalled with `isFinal === true`
 * so the trailing-edge outputs flush.
 *
 * Memory discipline (per design-transforms §"Memory discipline"):
 * never materialise a source-sized `Float32Array`. The persistent
 * per-chunk scratch is sized at the maximum upsampled chunk length
 * (for the 4× max-pool inner loop) and the maximum base-rate chunk
 * length (for the post-collapse slider input), not the source length.
 *
 * Phase 2 contract: iterate.ts will be rewritten to import this
 * function under its new name `buildBaseRateDetectionCache`, consume
 * the single returned `ChunkBuffer` as `detectionEnvelope` (base
 * rate, `frames === source.frames`), drop all references to
 * `upsampledSource`, and read the source `ChunkBuffer` directly at
 * base rate inside Walk B and `_unbuffer`. Until Phase 2 lands, the
 * iterate.ts call site will fail to typecheck because the old export
 * name is gone and the old two-cache return shape is gone — this is
 * expected per the plan's Phase 1 verification wording.
 */

import { ChunkBuffer } from "@buffered-audio/core";
import { SlidingWindowMaxStream, TruePeakUpsampler } from "@buffered-audio/utils";
import { CHUNK_FRAMES, OVERSAMPLE_FACTOR } from "./iterate";

export interface BuildBaseRateDetectionCacheArgs {
	buffer: ChunkBuffer;
	sampleRate: number;
	channelCount: number;
	frames: number;
	/**
	 * Half-width of the sliding-window max-pool in BASE-RATE samples.
	 * Per the base-rate-downstream rewrite, the slider runs at base
	 * rate, not the upsampled rate. The caller derives this via
	 * `windowSamplesFromMs(smoothingMs, baseRate)` — the same time
	 * spec (in ms) that produced the prior 4× halfWidth now produces
	 * a base-rate halfWidth one-quarter the size, covering the same
	 * temporal extent.
	 */
	halfWidth: number;
}

/**
 * Walk the source ChunkBuffer once at base rate and produce a single
 * `ChunkBuffer`: the base-rate, single-channel detection envelope
 * (post max-pool, post slider).
 *
 * Per chunk:
 *   - Upsample each channel inline to 4× via a per-channel
 *     `TruePeakUpsampler` (BS.1770-4 Annex 1 polyphase FIR, allocated
 *     at function entry, dropped at return).
 *   - Compute the linked 4×-rate detection signal
 *     `detection_4×[k] = max_c |upChannels[c][k]|`.
 *   - Collapse to base rate by max-of-4:
 *     `detection_base[n] = max(detection_4×[4n..4n+3])`. Exact
 *     preservation under max-of-max — see the plan's "Detection
 *     collapse strategy" discussion.
 *   - Push `detection_base` through `SlidingWindowMaxStream`
 *     instantiated at base rate with halved `halfWidth`.
 *   - Append the pooled output chunk to the detection envelope
 *     `ChunkBuffer`.
 *   - Drop the upsampled chunk — not stored, not returned.
 *
 * Invariants on return:
 *   - returned `ChunkBuffer.frames === frames` (base rate, source-
 *     sized; no `× OVERSAMPLE_FACTOR` factor anywhere).
 *   - returned `ChunkBuffer.channels === 1`.
 *   - No upsampled-source cache exists. Anywhere.
 *
 * The TruePeakUpsampler set, `SlidingWindowMaxStream`, and per-chunk
 * scratches are all local to this function — dropped on return.
 */
export async function buildBaseRateDetectionCache(
	args: BuildBaseRateDetectionCacheArgs,
): Promise<ChunkBuffer> {
	const { buffer, sampleRate, channelCount, frames, halfWidth } = args;

	const detectionEnvelope = new ChunkBuffer();

	if (frames === 0 || channelCount === 0) {
		return detectionEnvelope;
	}

	const sourceBitDepth = buffer.bitDepth;

	// Fresh per-channel BS.1770-4 Annex 1 polyphase FIR upsamplers for
	// THIS walk only. The 12-tap input history continues across chunks
	// of THIS walk; the array is dropped at function return. MUST NOT
	// be shared with the iteration's (now-gone) per-attempt upsamplers,
	// the stream class's persistent apply set (now also gone — Phase
	// 2.4 of the plan), or the measurement pre-pass upsamplers — those
	// have absorbed different signal histories. Replaces the prior
	// Butterworth-IIR `Oversampler` on this path so the curve's input
	// axis matches BS.1770-4 spec; the IIR underestimated inter-sample
	// peaks by ~0.5–1 dB vs RX / libebur128, which leaked above
	// `targetTp` in true-peak domain.
	const upsamplers: Array<TruePeakUpsampler> = [];

	for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
		upsamplers.push(new TruePeakUpsampler(OVERSAMPLE_FACTOR));
	}

	// Slider runs at BASE rate with halved halfWidth. The window
	// covers `[outputIdx - halfWidth, outputIdx + halfWidth]`
	// (inclusive both sides, total span `2 * halfWidth + 1` samples).
	// At base rate one sample is OVERSAMPLE_FACTOR× the duration of
	// an upsampled sample, so a halfWidth one-quarter the prior 4×
	// value covers the same milliseconds — see plan §"Detection
	// collapse strategy".
	const slidingWindow = new SlidingWindowMaxStream(halfWidth);
	// Persistent per-chunk scratches:
	//   - `detectScratch4x` holds the 4×-rate linked-detection signal
	//     for one chunk. Sized at `CHUNK_FRAMES * OVERSAMPLE_FACTOR`,
	//     reused via `.subarray(0, length)` for the variable last-
	//     chunk length.
	//   - `detectScratchBase` holds the post-collapse base-rate
	//     detection signal for one chunk, fed into the slider.
	//     Sized at `CHUNK_FRAMES`.
	// Both replace per-chunk `new Float32Array(...)` allocations.
	const detectScratch4x = new Float32Array(CHUNK_FRAMES * OVERSAMPLE_FACTOR);
	const detectScratchBase = new Float32Array(CHUNK_FRAMES);

	let consumedBaseFrames = 0;

	// Rewind read cursor — the framework's `processAndEmit` flow
	// leaves the cursor at end-of-buffer after `_process` completes,
	// but the caller here (loudness-target's iteration) reads the
	// source buffer from frame 0. Cheap and defensive.
	await buffer.reset();

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const channels = chunk.samples;
		const chunkFrames = channels[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		const upChunkLength = chunkFrames * OVERSAMPLE_FACTOR;
		// Upsample each channel to 4×. The upsampled chunks are
		// LOCAL to this iteration — consumed by the max-pool fill
		// loop and dropped at the bottom of the loop body.
		const upChannels: Array<Float32Array> = [];

		for (let channelIdx = 0; channelIdx < channels.length; channelIdx++) {
			const channel = channels[channelIdx];
			const upsampler = upsamplers[channelIdx];

			if (channel === undefined || upsampler === undefined) {
				upChannels.push(new Float32Array(upChunkLength));
				continue;
			}

			const slice = channel.length === chunkFrames ? channel : channel.subarray(0, chunkFrames);

			upChannels.push(upsampler.upsample(slice));
		}

		// 4×-rate linked detection signal: `max_c |upChannels[c][upIdx]|`
		// per upsampled sample. Same fill-loop shape as the prior design.
		const detect4xChunk = detectScratch4x.subarray(0, upChunkLength);

		for (let upIdx = 0; upIdx < upChunkLength; upIdx++) {
			let max = 0;

			for (let channelIdx = 0; channelIdx < upChannels.length; channelIdx++) {
				const upSample = upChannels[channelIdx]?.[upIdx] ?? 0;
				const absolute = Math.abs(upSample);

				if (absolute > max) max = absolute;
			}

			detect4xChunk[upIdx] = max;
		}

		// Collapse to base rate by max-of-4. Exact preservation under
		// the downstream max-pool operator: max is associative and
		// commutative with itself, so `max(slider(4× input)) ==
		// slider_at_base(max-of-4(4× input))` for any window. The
		// latter form is cheap (slider runs on 1/4 the samples).
		// Plain Float32Array loop per plan constraint — no SIMD.
		const detectBaseChunk = detectScratchBase.subarray(0, chunkFrames);

		for (let baseIdx = 0; baseIdx < chunkFrames; baseIdx++) {
			const upOffset = baseIdx * OVERSAMPLE_FACTOR;
			// OVERSAMPLE_FACTOR is 4; unroll explicitly to keep the
			// inner per-base-sample work to four loads + three
			// comparisons, dodging the variable-bound inner loop's
			// branch overhead per the plan's "plain Float32Array loop"
			// constraint.
			const s0 = detect4xChunk[upOffset] ?? 0;
			const s1 = detect4xChunk[upOffset + 1] ?? 0;
			const s2 = detect4xChunk[upOffset + 2] ?? 0;
			const s3 = detect4xChunk[upOffset + 3] ?? 0;
			const m01 = s0 > s1 ? s0 : s1;
			const m23 = s2 > s3 ? s2 : s3;

			detectBaseChunk[baseIdx] = m01 > m23 ? m01 : m23;
		}

		consumedBaseFrames += chunkFrames;

		const isFinal = consumedBaseFrames >= frames;
		const pooled = slidingWindow.push(detectBaseChunk, isFinal);

		// The leading-edge defer of `halfWidth` samples can produce
		// a zero-length `pooled` on the first chunk(s) until enough
		// input has been ingested. Skip the write in that case —
		// `write` short-circuits on duration 0 anyway, but the
		// explicit guard keeps the contract obvious.
		if (pooled.length > 0) {
			// Defensive note: `pooled` is a subview of `slidingWindow`'s
			// internal output buffer and can be overwritten by the
			// next `push`. The buffer's `write` path stores a
			// reference into its scratch via `.set(...)` which
			// copies, so this is safe — comment for documentation.
			//
			// Sample rate threaded as BASE rate (not 4×): the
			// detection envelope is now a base-rate signal. Bit
			// depth threaded from the source buffer's captured
			// metadata.
			await detectionEnvelope.write([pooled], sampleRate, sourceBitDepth);
		}

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	// Force any in-flight write batch to disk so downstream readers
	// (Phase 2's base-rate Walk A) see a consistent state. The
	// buffer's read path spans head-scratch / disk / tail-scratch
	// transparently, but flushing makes the contract obvious and
	// avoids surprising the reset-then-read pattern used in
	// iterate.ts.
	await detectionEnvelope.flushWrites();

	return detectionEnvelope;
}
