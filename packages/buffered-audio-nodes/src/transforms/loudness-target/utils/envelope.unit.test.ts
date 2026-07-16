import { BlockBuffer } from "@buffered-audio/core";
import { BidirectionalIir, slidingWindowMin } from "@buffered-audio/utils";
import { describe, expect, it } from "vitest";
import { type Anchors, gainDbAt } from "./curve";
import { applyBackwardPassOverChunkBuffer, windowSamplesFromMs } from "./envelope";

const SAMPLE_RATE = 48000;

/**
 * Tests for the disk-backed backward-IIR helper introduced in Phase 3
 * of `plan-loudness-target-stream-caching`. The "reverse twice" trick
 * MUST produce output byte-equal-or-ULP to the in-memory
 * `BidirectionalIir.applyBackwardPassInPlace` reference on the same
 * data — that equivalence is the load-bearing claim for swapping
 * iteration's `applyBackwardPassInPlace(forwardScratch)` call to the
 * disk-backed path without changing convergence trajectories.
 */
describe("applyBackwardPassOverChunkBuffer", () => {
	const SMOOTHING_MS = 1;
	// `applyBackwardPassInPlace` and `applyForwardPass` over a reversed
	// signal differ only by floating-point summation order — the same
	// `alpha * x + (1 - alpha) * y` recurrence, fed in opposite walk
	// directions. Empirically the two produce identical IEEE-754
	// results on synthetic Float32 inputs, but allow a tight ULP-scale
	// tolerance for robustness across architectures.
	const ULP_TOLERANCE = 1e-6;

	async function makeFileBufferFromSamples(samples: Float32Array): Promise<BlockBuffer> {
		const buffer = new BlockBuffer();

		await buffer.write([new Float32Array(samples)]);
		await buffer.flushWrites();

		return buffer;
	}

	async function readAll(buffer: BlockBuffer): Promise<Float32Array> {
		await buffer.reset();
		const chunk = await buffer.read(buffer.frames);

		return chunk.samples[0] ?? new Float32Array(0);
	}

	it("byte-equal-or-ULP match with applyBackwardPassInPlace on random data, single chunk", async () => {
		const length = 20_000;
		const random = new Float32Array(length);

		for (let i = 0; i < length; i++) {
			random[i] = Math.sin(i * 0.01) * 0.5 + (i * 0.000_173) % 0.3;
		}

		// Reference: in-memory backward IIR.
		const referenceCopy = new Float32Array(random);
		const referenceIir = new BidirectionalIir({ smoothingMs: SMOOTHING_MS, sampleRate: SAMPLE_RATE });

		referenceIir.applyBackwardPassInPlace(referenceCopy);

		// Disk-backed path.
		const sourceBuffer = await makeFileBufferFromSamples(random);
		const destBuffer = new BlockBuffer();
		const iir = new BidirectionalIir({ smoothingMs: SMOOTHING_MS, sampleRate: SAMPLE_RATE });

		await applyBackwardPassOverChunkBuffer({
			sourceBuffer,
			destBuffer,
			iir,
			chunkSize: length, // single-chunk case
		});

		const actual = await readAll(destBuffer);

		expect(actual.length).toBe(length);
		for (let i = 0; i < length; i++) {
			expect(actual[i] ?? 0).toBeCloseTo(referenceCopy[i] ?? 0, 6);
		}

		// Also check the maximum absolute deviation is within the ULP
		// tolerance — looser-tolerance summary assert that catches
		// per-sample drift the toBeCloseTo loop's tolerance might miss
		// at extreme magnitudes.
		let maxDelta = 0;

		for (let i = 0; i < length; i++) {
			const delta = Math.abs((actual[i] ?? 0) - (referenceCopy[i] ?? 0));

			if (delta > maxDelta) maxDelta = delta;
		}
		expect(maxDelta).toBeLessThan(ULP_TOLERANCE);

		await sourceBuffer.close();
		await destBuffer.close();
	});

	it("state continuity across chunks: multi-chunk result matches single-chunk reference", async () => {
		// Fixture larger than the chunk stride so the reverse walk
		// traverses multiple chunks and threads state across them.
		const length = 250_003; // not a multiple of chunkSize — exercises the leading short chunk
		const chunkSize = 44_100; // mimics CHUNK_FRAMES at the upsampled stride (loose proxy)
		const random = new Float32Array(length);

		for (let i = 0; i < length; i++) {
			random[i] = Math.cos(i * 0.013) * 0.4 + ((i * 0.000_29) % 0.2 - 0.1);
		}

		// In-memory reference — whole-array.
		const referenceCopy = new Float32Array(random);
		const referenceIir = new BidirectionalIir({ smoothingMs: SMOOTHING_MS, sampleRate: SAMPLE_RATE });

		referenceIir.applyBackwardPassInPlace(referenceCopy);

		const sourceBuffer = await makeFileBufferFromSamples(random);
		const destBuffer = new BlockBuffer();
		const iir = new BidirectionalIir({ smoothingMs: SMOOTHING_MS, sampleRate: SAMPLE_RATE });
		const progressReports: Array<{ done: number; total: number }> = [];

		await applyBackwardPassOverChunkBuffer({
			sourceBuffer,
			destBuffer,
			iir,
			chunkSize,
			progress: (done, total) => progressReports.push({ done, total }),
		});

		const actual = await readAll(destBuffer);

		expect(actual.length).toBe(length);

		let maxDelta = 0;

		for (let i = 0; i < length; i++) {
			const delta = Math.abs((actual[i] ?? 0) - (referenceCopy[i] ?? 0));

			if (delta > maxDelta) maxDelta = delta;
		}
		expect(maxDelta).toBeLessThan(ULP_TOLERANCE);
		expect(progressReports.length).toBeGreaterThan(2);
		expect(progressReports.at(-1)).toEqual({ done: length * 2, total: length * 2 });

		for (let reportIndex = 0; reportIndex < progressReports.length; reportIndex++) {
			const report = progressReports[reportIndex];
			const previous = progressReports[reportIndex - 1];

			expect(report?.done).toBeGreaterThanOrEqual(previous?.done ?? 0);
			expect(report?.total).toBe(length * 2);
		}

		await sourceBuffer.close();
		await destBuffer.close();
	});

	it("empty source buffer is a no-op (no writes to dest)", async () => {
		const sourceBuffer = new BlockBuffer();
		const destBuffer = new BlockBuffer();
		const iir = new BidirectionalIir({ smoothingMs: SMOOTHING_MS, sampleRate: SAMPLE_RATE });

		await applyBackwardPassOverChunkBuffer({
			sourceBuffer,
			destBuffer,
			iir,
			chunkSize: 1024,
		});

		expect(destBuffer.frames).toBe(0);

		await sourceBuffer.close();
		await destBuffer.close();
	});

	it("brick-wall exactness: spike in flat-low region clamps to per-sample target gain", async () => {
		// Phase 1 of `plan-loudness-target-deterministic`: with the
		// min-hold + per-sample clamp in place, the output gain at the
		// peak sample of any source equals `gainDbAt(peakLevel)` exactly
		// (within float32 precision). Construct a synthetic per-sample
		// linear-gain envelope with one spike-down (heavier attenuation)
		// in an otherwise flat-low (lighter gain) region, simulate the
		// Walk-A pipeline in memory, drive the disk-backed backward pass
		// with the min-held ceiling, and check the spike sample lands on
		// its own target gain — NOT averaged with the surrounding lighter
		// gains the IIR would otherwise pull in.
		const length = 4000;
		const halfWidth = windowSamplesFromMs(1, SAMPLE_RATE); // 48 samples
		const peakIdx = 2000;

		// Anchors picked so the descending upper segment + brick-wall
		// gives the peak sample noticeably less gain than the body.
		const anchors: Anchors = {
			floorDb: null,
			pivotDb: -30,
			limitDb: -3,
			B: 6,
			peakGainDb: 2,
		};

		// Body sits below pivot → uniform body gain `B`. Peak hits the
		// brick-wall extension above `limitDb`.
		const bodyLevelDb = -40;
		const peakLevelDb = +3;

		// Per-sample gain envelope before min-hold: flat-body gain
		// everywhere except a single sample at `peakIdx` that gets the
		// brick-wall gain.
		const gPerSample = new Float32Array(length);
		const bodyGainLinear = Math.pow(10, gainDbAt(bodyLevelDb, anchors) / 20);
		const peakGainLinear = Math.pow(10, gainDbAt(peakLevelDb, anchors) / 20);

		gPerSample.fill(bodyGainLinear);
		gPerSample[peakIdx] = peakGainLinear;

		// Stage 1 (in-memory reference): sliding-window-min on the linear
		// gain. The peak sample's heavy gain propagates over the
		// `[peakIdx - halfWidth, peakIdx + halfWidth]` window.
		const gMinHold = slidingWindowMin(gPerSample, halfWidth);

		// Stage 2 (in-memory reference): forward IIR on the min-held
		// gain. This is the input the disk-backed backward pass receives.
		const iir = new BidirectionalIir({ smoothingMs: 1, sampleRate: SAMPLE_RATE });
		const forwardState = { value: gMinHold[0] ?? 0 };
		const gForward = iir.applyForwardPass(gMinHold, forwardState);

		// Drive the disk-backed backward pass with the min-held ceiling
		// and confirm the clamp fires at the peak.
		const sourceBuffer = await makeFileBufferFromSamples(gForward);
		const minHeldBuffer = await makeFileBufferFromSamples(gMinHold);
		const destBuffer = new BlockBuffer();

		await applyBackwardPassOverChunkBuffer({
			sourceBuffer,
			destBuffer,
			iir,
			chunkSize: 512,
			minHeldBuffer,
		});

		const gFinal = await readAll(destBuffer);

		expect(gFinal.length).toBe(length);
		// Brick-wall exactness: the peak sample equals the per-sample
		// target gain (i.e. the brick-wall gain at the peak's own level).
		expect(Math.abs((gFinal[peakIdx] ?? 0) - peakGainLinear)).toBeLessThan(1e-6);

		// Invariant `g_final[k] <= g_min_hold[k]` for every sample: the
		// clamp can only pull gain DOWN, never up.
		for (let frameIdx = 0; frameIdx < length; frameIdx++) {
			const final = gFinal[frameIdx] ?? 0;
			const minHold = gMinHold[frameIdx] ?? 0;

			expect(final).toBeLessThanOrEqual(minHold + 1e-6);
		}

		await sourceBuffer.close();
		await minHeldBuffer.close();
		await destBuffer.close();
	});

	it("in-memory BlockBuffer source (lifetime under 10MB stays in scratch)", async () => {
		// Sequential-API form: a small BlockBuffer never touches disk
		// (lifetime under the 10MB scratch threshold) yet still feeds
		// the backward-pass walker correctly. Replaces the old
		// `MemoryChunkBuffer` polymorphism test — there is only one
		// concrete class now, but the small-buffer path is the
		// observable equivalent.
		const length = 5000;
		const random = new Float32Array(length);

		for (let i = 0; i < length; i++) random[i] = Math.sin(i * 0.02);

		const memSource = new BlockBuffer();

		await memSource.write([new Float32Array(random)]);

		const destBuffer = new BlockBuffer();
		const iir = new BidirectionalIir({ smoothingMs: SMOOTHING_MS, sampleRate: SAMPLE_RATE });

		await applyBackwardPassOverChunkBuffer({
			sourceBuffer: memSource,
			destBuffer,
			iir,
			chunkSize: 1024,
		});

		const referenceCopy = new Float32Array(random);

		new BidirectionalIir({ smoothingMs: SMOOTHING_MS, sampleRate: SAMPLE_RATE }).applyBackwardPassInPlace(referenceCopy);

		const actual = await readAll(destBuffer);

		for (let i = 0; i < length; i++) {
			expect(actual[i] ?? 0).toBeCloseTo(referenceCopy[i] ?? 0, 6);
		}

		await memSource.close();
		await destBuffer.close();
	});
});
