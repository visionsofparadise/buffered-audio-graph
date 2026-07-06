import { BlockBuffer } from "@buffered-audio/core";
import { SlidingWindowMaxStream, TruePeakUpsampler, linearToDb } from "@buffered-audio/utils";
import { describe, expect, it } from "vitest";
import { CHUNK_FRAMES, OVERSAMPLE_FACTOR } from "./iterate";
import { SourceMeasurementAccumulator } from "./measurement";
import { buildBaseRateDetectionCache } from "./source-caches";

const SAMPLE_RATE = 48_000;

/** LCG (numerical-recipes constants) for deterministic noise. */
function makeLcg(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

		return state / 0x80_00_00_00 - 1;
	};
}

function makeSineWithNoise(seed: number, frames: number, amplitude: number, frequency: number): Float32Array {
	const channel = new Float32Array(frames);
	const rand = makeLcg(seed);
	const angularStep = (2 * Math.PI * frequency) / SAMPLE_RATE;

	for (let frameIdx = 0; frameIdx < frames; frameIdx++) {
		channel[frameIdx] = amplitude * (0.7 * Math.sin(angularStep * frameIdx) + 0.3 * rand());
	}

	return channel;
}

async function makeBufferFromChannels(channels: ReadonlyArray<Float32Array>): Promise<BlockBuffer> {
	const buffer = new BlockBuffer();

	await buffer.write(channels.map((c) => new Float32Array(c)), SAMPLE_RATE, 32);
	await buffer.flushWrites();

	return buffer;
}

/**
 * Read all frames from a single-channel BlockBuffer into a flat
 * `Float32Array`. Used to compare cached output against reference
 * single-pass output computed in test code. Reads at base rate (post
 * `plan-loudness-target-base-rate-downstream`).
 */
async function readAllSingleChannel(buffer: BlockBuffer): Promise<Float32Array> {
	const totalFrames = buffer.frames;
	const out = new Float32Array(totalFrames);

	if (totalFrames === 0) return out;

	await buffer.reset();
	const chunkSize = CHUNK_FRAMES;
	let offset = 0;

	while (offset < totalFrames) {
		const want = Math.min(chunkSize, totalFrames - offset);
		const chunk = await buffer.read(want);
		const src = chunk.samples[0];
		const got = src?.length ?? 0;

		if (got === 0 || src === undefined) break;

		out.set(src, offset);
		offset += got;
	}

	return out;
}

describe("buildBaseRateDetectionCache", () => {
	it("produces a single base-rate detection BlockBuffer (no upsampled-source cache)", async () => {
		// Use ~2.5 chunks so we exercise both the steady-state path and
		// the trailing short chunk. Post the 2026-05-13 base-rate-
		// downstream rewrite the function returns a SINGLE BlockBuffer
		// (the detection envelope) at base rate — no upsampled-source
		// cache exists.
		const frames = Math.floor(CHUNK_FRAMES * 2.5);
		const channels = [
			makeSineWithNoise(0xABCD_1234, frames, 0.2, 440),
			makeSineWithNoise(0x1234_ABCD, frames, 0.25, 660),
		];
		const buffer = await makeBufferFromChannels(channels);
		const halfWidth = 50; // base-rate halfWidth, small for fast test

		const detectionEnvelope = await buildBaseRateDetectionCache({
			buffer,
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			frames,
			halfWidth,
		});

		try {
			// Base-rate contract: detection envelope has exactly `frames`
			// samples (no `× OVERSAMPLE_FACTOR` factor anywhere).
			expect(detectionEnvelope.frames).toBe(frames);
			expect(detectionEnvelope.channels).toBe(1);
			// Sample-rate metadata is base rate, not 4×.
			expect(detectionEnvelope.sampleRate).toBe(SAMPLE_RATE);
		} finally {
			await detectionEnvelope.close();
			await buffer.close();
		}
	});

	it("detection envelope matches reference: per-chunk 4× upsample → max-of-channels → max-of-4 → base-rate slider", async () => {
		const frames = Math.floor(CHUNK_FRAMES * 1.3);
		const channels = [
			makeSineWithNoise(0xFEED_DEAD, frames, 0.4, 1000),
			makeSineWithNoise(0x5A5A_A5A5, frames, 0.35, 1500),
		];
		const buffer = await makeBufferFromChannels(channels);
		const halfWidth = 50; // base-rate halfWidth

		const detectionEnvelope = await buildBaseRateDetectionCache({
			buffer,
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			frames,
			halfWidth,
		});

		try {
			// Reference: replicate the cache builder's interior — fresh
			// per-channel BS.1770-4 Annex 1 polyphase FIR upsamplers,
			// fresh sliding window, fused walk at base rate. Per-chunk
			// 4× upsample → max-of-channels at 4× rate → max-of-4
			// collapse to base rate → push base-rate chunk through
			// slider.
			const refOversamplers = [
				new TruePeakUpsampler(OVERSAMPLE_FACTOR),
				new TruePeakUpsampler(OVERSAMPLE_FACTOR),
			];
			const slidingWindow = new SlidingWindowMaxStream(halfWidth);
			const refDetection = new Float32Array(frames);
			let writeOffset = 0;
			let consumed = 0;

			await buffer.reset();
			for (;;) {
				const chunk = await buffer.read(CHUNK_FRAMES);
				const chunkFrames = chunk.samples[0]?.length ?? 0;

				if (chunkFrames === 0) break;

				const upChunkLength = chunkFrames * OVERSAMPLE_FACTOR;
				const upChannels: Array<Float32Array> = [];

				for (let ch = 0; ch < 2; ch++) {
					upChannels.push(refOversamplers[ch]!.upsample(chunk.samples[ch]!));
				}

				// 4×-rate detection (max across channels).
				const detect4x = new Float32Array(upChunkLength);

				for (let upIdx = 0; upIdx < upChunkLength; upIdx++) {
					let max = 0;

					for (let ch = 0; ch < 2; ch++) {
						const v = Math.abs(upChannels[ch]?.[upIdx] ?? 0);

						if (v > max) max = v;
					}

					detect4x[upIdx] = max;
				}

				// Max-of-4 collapse to base rate.
				const detectBase = new Float32Array(chunkFrames);

				for (let baseIdx = 0; baseIdx < chunkFrames; baseIdx++) {
					const upOffset = baseIdx * OVERSAMPLE_FACTOR;
					const s0 = detect4x[upOffset] ?? 0;
					const s1 = detect4x[upOffset + 1] ?? 0;
					const s2 = detect4x[upOffset + 2] ?? 0;
					const s3 = detect4x[upOffset + 3] ?? 0;
					const m01 = s0 > s1 ? s0 : s1;
					const m23 = s2 > s3 ? s2 : s3;

					detectBase[baseIdx] = m01 > m23 ? m01 : m23;
				}

				consumed += chunkFrames;
				const isFinal = consumed >= frames;
				const pooled = slidingWindow.push(detectBase, isFinal);

				if (pooled.length > 0) {
					// Detection envelope is stored in dB (the producer converts the LINEAR pooled slider output via
					// linearToDb into an f32 scratch). Mirror that here so the byte-exact maxDiff === 0 contract holds:
					// f32-store dB, same rounding path as the buffer write.
					const dbPooled = new Float32Array(pooled.length);

					for (let i = 0; i < pooled.length; i++) {
						dbPooled[i] = linearToDb(pooled[i] ?? 0);
					}

					refDetection.set(dbPooled, writeOffset);
					writeOffset += pooled.length;
				}

				if (chunkFrames < CHUNK_FRAMES) break;
			}

			expect(writeOffset).toBe(frames);

			const got = await readAllSingleChannel(detectionEnvelope);

			expect(got.length).toBe(refDetection.length);

			let maxDiff = 0;

			for (let i = 0; i < refDetection.length; i++) {
				const diff = Math.abs(refDetection[i]! - got[i]!);

				if (diff > maxDiff) maxDiff = diff;
			}

			expect(maxDiff).toBe(0);
		} finally {
			await detectionEnvelope.close();
			await buffer.close();
		}
	});

	it("inter-sample peak preservation: post-collapse detection exceeds base-rate source maxima at the peak's neighborhood", async () => {
		// Synthetic fixture: a high-frequency transient that produces
		// inter-sample peaks when reconstructed at 4× rate. Use a
		// short burst of a near-Nyquist sine on a single channel; the
		// 4× upsampler's reconstruction filter produces inter-sample
		// excursions larger than any base-rate sample.
		//
		// Post the base-rate-downstream rewrite the detection cache
		// captures these via the inline 4× upsample + max-of-4
		// collapse, so the post-collapse detection envelope at the
		// peak's neighborhood reports a level ABOVE the per-base-sample
		// |source| there. This is the structural reason for retaining
		// the 4× upsample for detection only.
		const frames = 4096;
		const channel = new Float32Array(frames);
		// Place an 11 kHz tone near Nyquist (24 kHz at 48 kHz sample
		// rate) — its 4× reconstruction has inter-sample peaks well
		// above the base-rate samples for short durations.
		// Amplitude 0.6 keeps the signal well below clipping.
		const fNear = 11_000;
		const angular = (2 * Math.PI * fNear) / SAMPLE_RATE;

		for (let i = 0; i < frames; i++) {
			// Localise a transient around index 2000–2050 — outside the
			// halfWidth lead-in / tail-out so the slider sees the full
			// neighborhood.
			const envelope = i >= 2000 && i < 2050 ? 0.6 : 0;

			channel[i] = envelope * Math.sin(angular * i);
		}

		const buffer = await makeBufferFromChannels([channel]);
		const halfWidth = 4; // tight slider so the test reads close to the transient

		const detectionEnvelope = await buildBaseRateDetectionCache({
			buffer,
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			frames,
			halfWidth,
		});

		try {
			const got = await readAllSingleChannel(detectionEnvelope);
			// Inside the transient region, base-rate |x| is bounded by
			// 0.6 (the envelope amplitude); the 4× reconstruction's
			// inter-sample peaks exceed 0.6 for this near-Nyquist tone.
			// Find the max base-rate |source| in the transient region.
			let maxBaseAbs = 0;

			for (let i = 2000; i < 2050; i++) {
				const v = Math.abs(channel[i] ?? 0);

				if (v > maxBaseAbs) maxBaseAbs = v;
			}

			// Detection envelope is stored in dB; linearToDb is monotonic, so the strictly-larger relationship is
			// preserved on the dB axis. Compare both quantities in dB.
			const maxBaseAbsDb = linearToDb(maxBaseAbs);
			// Find the max post-collapse detection (dB) in the transient
			// region (slightly widened to absorb slider lead/lag).
			let maxDetectionDb = -Infinity;

			for (let i = 1980; i < 2070; i++) {
				const v = got[i] ?? -Infinity;

				if (v > maxDetectionDb) maxDetectionDb = v;
			}
			// The structural property: detection sees a strictly
			// LARGER level than the base-rate source samples in the
			// peak's neighborhood. If max-of-4 ever degraded to "every
			// 4th sample of upsampled" this assertion would fire.
			expect(maxDetectionDb).toBeGreaterThan(maxBaseAbsDb);
		} finally {
			await detectionEnvelope.close();
			await buffer.close();
		}
	});

	it("temporal coverage: post-slider detection holds a transient peak for 2*halfWidth+1 base-rate samples", async () => {
		// Synthetic: a single base-rate sample of large amplitude in
		// the middle of a quiet field, on one channel. After the
		// max-of-4 collapse this lands as a single base-rate "spike"
		// in the detection-base signal. The slider then holds the
		// spike across `[n - halfWidth, n + halfWidth]` (inclusive
		// both sides — `2 × halfWidth + 1` base-rate samples). This
		// proves the slider's window covers the same temporal extent
		// at base rate as it did at 4× rate (halved halfWidth → halved
		// upsampled-sample count, same milliseconds).
		const frames = 1024;
		const halfWidth = 7; // base-rate halfWidth, picked small for an exact spike count
		const channel = new Float32Array(frames);
		const spikeIdx = 500;

		channel[spikeIdx] = 0.9;

		const buffer = await makeBufferFromChannels([channel]);

		const detectionEnvelope = await buildBaseRateDetectionCache({
			buffer,
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			frames,
			halfWidth,
		});

		try {
			const got = await readAllSingleChannel(detectionEnvelope);
			// Find the spike's resulting plateau in the post-collapse
			// signal. The 4× upsample's reconstruction filter splatters
			// the spike across a small neighborhood of upsampled
			// samples (and also induces a small filter-group-delay
			// offset relative to the input spike index); after max-of-4
			// collapse this lands as a small cluster of non-zero
			// base-rate samples in the spike's neighborhood. The
			// slider then propagates the cluster's max across
			// `[k - halfWidth, k + halfWidth]` for each non-zero
			// cluster sample k — so the union of all such windows
			// stretches from `(cluster_first - halfWidth)` to
			// `(cluster_last + halfWidth)` inclusive.
			//
			// We assert: the post-slider envelope holds the cluster
			// max across AT LEAST `2 × halfWidth + 1` consecutive
			// base-rate samples. The cluster's exact centre depends
			// on the upsampler's filter response (a few base-rate
			// samples around the spike), so the assertion locates the
			// max's actual position in the post-slider signal and
			// counts the surrounding plateau — locking the slider's
			// `±halfWidth` widening property without fragility against
			// the upsampler's filter delay.
			// Detection envelope is stored in dB now: the 0.9 spike lands
			// near −0.9 dB while the quiet field is linearToDb(0) = −200 dB
			// (the clamp floor). So clusterMax is a NEGATIVE-but-finite dB
			// value well above the silence floor; init to −Infinity and use
			// a −Infinity missing-sample sentinel (silence-equivalent, not
			// 0 dB = full scale).
			let clusterMax = -Infinity;
			let clusterMaxIdx = -1;

			for (let i = spikeIdx - 16; i <= spikeIdx + 16; i++) {
				const v = got[i] ?? -Infinity;

				if (v > clusterMax) {
					clusterMax = v;
					clusterMaxIdx = i;
				}
			}
			// Spike ≈ −0.9 dB; quiet field ≈ −200 dB. A clean separation:
			// clusterMax sits well above −100 dB.
			expect(clusterMax).toBeGreaterThan(-100);
			expect(clusterMaxIdx).toBeGreaterThanOrEqual(0);

			// Walk outward from `clusterMaxIdx` to find the maximal
			// contiguous run of samples holding `clusterMax` (within
			// a tight tolerance for IEEE-754 rounding). The slider's
			// contract: every sample within `±halfWidth` of a cluster
			// sample holds at least that cluster sample's value. Since
			// the cluster spans multiple base-rate samples around
			// `clusterMaxIdx`, the post-slider plateau is at least
			// `2 × halfWidth + 1` long. Absolute dB tolerance (a relative
			// `clusterMax * 1e-6` would invert sign under negative dB).
			const tolerance = 1e-4;
			let left = clusterMaxIdx;

			while (left > 0 && (got[left - 1] ?? -Infinity) >= clusterMax - tolerance) left--;

			let right = clusterMaxIdx;

			while (right < got.length - 1 && (got[right + 1] ?? -Infinity) >= clusterMax - tolerance) right++;

			const plateauWidth = right - left + 1;

			expect(plateauWidth).toBeGreaterThanOrEqual(2 * halfWidth + 1);
		} finally {
			await detectionEnvelope.close();
			await buffer.close();
		}
	});

	it("producer parity: detection envelope is bit-identical to SourceMeasurementAccumulator at a slider-drain-overflow length", async () => {
		// Regression pin for the fixed-scratch truncation (Phase 2 review, Finding 1). On the FINAL push the
		// SlidingWindowMaxStream drains its deferred look-ahead and emits `chunkFrames + halfWidth` samples in one
		// call. With `frames` an exact multiple of CHUNK_FRAMES, the final source-caches push emits
		// CHUNK_FRAMES + halfWidth > CHUNK_FRAMES samples — the old fixed-CHUNK_FRAMES dbScratch clamped
		// `subarray(0, pooled.length)` to CHUNK_FRAMES, dropped the last `halfWidth` dB samples (silent TypedArray
		// no-ops), and wrote a short envelope. SourceMeasurementAccumulator's grow-on-demand toDbScratch never
		// truncates, so the two producers diverged on this length — breaking the "envelope must be bit-identical to
		// buildBaseRateDetectionCache" contract. This test fails on the pre-fix sizing and passes after.
		const frames = 2 * CHUNK_FRAMES; // 88_200 — final push emits CHUNK_FRAMES + halfWidth > CHUNK_FRAMES
		const halfWidth = 480; // > 0 so the drain overflows CHUNK_FRAMES; matches the anchor render's smoothing
		const channels = [
			makeSineWithNoise(0xDEAD_BEEF, frames, 0.42, 750),
			makeSineWithNoise(0x0FF1_CE00, frames, 0.31, 1230),
		];

		const cacheBuffer = await makeBufferFromChannels(channels);
		const accumBuffer = await makeBufferFromChannels(channels);

		const detectionEnvelope = await buildBaseRateDetectionCache({
			buffer: cacheBuffer,
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			frames,
			halfWidth,
		});

		// Drive SourceMeasurementAccumulator exactly as measureSource does (CHUNK_FRAMES reads, push, finalize),
		// writing its detection envelope into a BlockBuffer for comparison.
		const accumEnvelope = new BlockBuffer();
		const accumulator = new SourceMeasurementAccumulator(SAMPLE_RATE, 2, 0.98, halfWidth, accumEnvelope);

		await accumBuffer.reset();
		for (;;) {
			const chunk = await accumBuffer.read(CHUNK_FRAMES);
			const chunkFrames = chunk.samples[0]?.length ?? 0;

			if (chunkFrames === 0) break;

			await accumulator.push(chunk.samples, chunkFrames);

			if (chunkFrames < CHUNK_FRAMES) break;
		}

		await accumulator.finalize();

		try {
			const gotCache = await readAllSingleChannel(detectionEnvelope);
			const gotAccum = await readAllSingleChannel(accumEnvelope);

			// The invariant: both producers must emit `frames` samples (nothing truncated). Under the pre-fix
			// sizing the cache envelope was short by `halfWidth`, so this length check alone would fire.
			expect(gotCache.length).toBe(frames);
			expect(gotAccum.length).toBe(frames);

			let maxDiff = 0;

			for (let sampleIdx = 0; sampleIdx < frames; sampleIdx++) {
				const diff = Math.abs((gotCache[sampleIdx] ?? 0) - (gotAccum[sampleIdx] ?? 0));

				if (diff > maxDiff) maxDiff = diff;
			}

			// Same source, same halfWidth, same linearToDb → bit-identical envelope (both f32).
			expect(maxDiff).toBe(0);
		} finally {
			await detectionEnvelope.close();
			await accumEnvelope.close();
			await cacheBuffer.close();
			await accumBuffer.close();
		}
	});

	it("handles zero-frame source by returning an empty buffer", async () => {
		const buffer = await makeBufferFromChannels([new Float32Array(0)]);

		const detectionEnvelope = await buildBaseRateDetectionCache({
			buffer,
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			frames: 0,
			halfWidth: 100,
		});

		try {
			expect(detectionEnvelope.frames).toBe(0);
		} finally {
			await detectionEnvelope.close();
			await buffer.close();
		}
	});
});
