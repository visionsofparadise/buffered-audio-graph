import { tmpdir } from "node:os";
import { BlockBuffer } from "@buffered-audio/core";
import { LoudnessAccumulator, TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";
import { afterEach, describe, expect, it } from "vitest";
import { windowSamplesFromMs } from "./envelope";
import {
	attemptBeatsWinner,
	clampLimit,
	iterateForTargets as iterateForTargetsInTemporaryDirectory,
	type IterateForTargetsArgs,
	type IterationAttempt,
} from "./iterate";
import { measureSource } from "./measurement";

const SAMPLE_RATE = 48_000;
const DURATION_SECONDS = 8;
const FRAME_COUNT = SAMPLE_RATE * DURATION_SECONDS;
const DEFAULT_LIMIT_PERCENTILE = 0.995;

function iterateForTargets(args: Omit<IterateForTargetsArgs, "temporaryDirectory">) {
	return iterateForTargetsInTemporaryDirectory({ ...args, temporaryDirectory: tmpdir() });
}

/**
 * Per-file registry of `BlockBuffer`s that must be closed at the end
 * of each test. `makeBufferFromChannels` pushes inputs; tests push the
 * `iterateForTargets` result's `bestSmoothedEnvelopeBuffer` via
 * `trackResultBuffers`. Drained by the `afterEach` hook below.
 */
const buffersToClose: Array<BlockBuffer> = [];

/**
 * Wrap per-channel synthetic arrays in a `BlockBuffer`.
 */
async function makeBufferFromChannels(channels: ReadonlyArray<Float32Array>): Promise<BlockBuffer> {
	const buffer = new BlockBuffer();

	await buffer.write(
		channels.map((channel) => new Float32Array(channel)),
		SAMPLE_RATE,
		32,
	);
	await buffer.flushWrites();

	buffersToClose.push(buffer);

	return buffer;
}

/**
 * Track the buffers returned by `iterateForTargets` so the
 * `afterEach` hook can release them. The iterator's `finally` closes
 * the loser of `activeBufferA / activeBufferB` and the transient
 * `forwardEnvelopeBuffer`; the winner (`bestSmoothedEnvelopeBuffer`)
 * is returned to the caller and outlives the function — this file's
 * responsibility to close. Post the 2026-05-13 base-rate-downstream
 * rewrite there is no upsampled-source cache to track.
 */
function trackResultBuffers(result: { bestSmoothedEnvelopeBuffer: BlockBuffer }): void {
	buffersToClose.push(result.bestSmoothedEnvelopeBuffer);
}

async function histogramOf(buffer: BlockBuffer, smoothingMs: number) {
	const measurement = await measureSource(
		buffer,
		SAMPLE_RATE,
		DEFAULT_LIMIT_PERCENTILE,
		windowSamplesFromMs(smoothingMs, SAMPLE_RATE),
	);

	return measurement.detectionHistogram;
}

/** LCG (numerical-recipes constants) for deterministic noise. */
function makeLcg(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

		return state / 0x80_00_00_00 - 1;
	};
}

/**
 * Synthetic source: 220 Hz sine plus shaped noise. With `dipDepth < 1`
 * the source has a 1-second-period envelope (alternating amplitude
 * 1 / `dipDepth`) so multiple short-term blocks see different levels
 * and LRA accumulates above zero.
 *
 * Note: the plan's nominal "sine -22 LUFS, peak -3 dBFS" pair isn't
 * realisable with a pure sine (sine LUFS ≈ -6 dB below dBTP). The
 * test source instead lands at a body LUFS comfortably below the
 * test's `pivotDb` so the iteration's slope on `B → outputLufs` is
 * well-conditioned.
 */
function makeSyntheticSource(seed: number, amplitude: number, dipDepth: number): Array<Float32Array> {
	const channel = new Float32Array(FRAME_COUNT);
	const rand = makeLcg(seed);
	const angularStep = (2 * Math.PI * 220) / SAMPLE_RATE;

	for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex++) {
		const sine = Math.sin(angularStep * frameIndex);
		const noise = rand() * 0.05;
		const second = Math.floor(frameIndex / SAMPLE_RATE);
		const envelope = second % 2 === 0 ? 1 : dipDepth;

		channel[frameIndex] = amplitude * envelope * (sine + noise);
	}

	return [channel];
}

interface SourceMetrics {
	integratedLufs: number;
	lra: number;
	truePeakDb: number;
}

function measureSourceMetrics(channels: ReadonlyArray<Float32Array>): SourceMetrics {
	const loudness = new LoudnessAccumulator(SAMPLE_RATE, channels.length);
	const truePeak = new TruePeakAccumulator(SAMPLE_RATE, channels.length);
	const length = channels[0]?.length ?? 0;

	loudness.push(channels, length);
	truePeak.push(channels, length);

	const lr = loudness.finalize();

	return { integratedLufs: lr.integrated, lra: lr.range, truePeakDb: linearToDb(truePeak.finalize()) };
}

describe("iterateForTargets", () => {
	const TEST_TIMEOUT_MS = 120_000;

	afterEach(async () => {
		for (const buf of buffersToClose) {
			await buf.close();
		}

		buffersToClose.length = 0;
	});

	it(
		"converges within tolerance on a typical source (1D-on-B)",
		async () => {
			const source = makeSyntheticSource(0xdead_beef, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);

			expect(Number.isFinite(metrics.integratedLufs)).toBe(true);
			expect(metrics.lra).toBeGreaterThan(0);

			const targetLufs = Math.round((metrics.integratedLufs + 3) * 10) / 10;
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);
			const progressReports: Array<{ done: number; total: number }> = [];
			const reportedAttempts: Array<{ attempt: IterationAttempt; attemptIndex: number }> = [];
			let progressCountAtFirstAttempt: number | undefined;

			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -10 },
				smoothingMs: 1,
				targetLufs,
				targetTp: 0,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance: 0.5,
				neverExpand: true,
				histogram,
				progress: (done, total) => progressReports.push({ done, total }),
				onAttempt: (attempt, attemptIndex) => {
					progressCountAtFirstAttempt ??= progressReports.length;
					reportedAttempts.push({ attempt, attemptIndex });
				},
			});

			trackResultBuffers(result);

			expect(result.converged).toBe(true);
			expect(result.attempts.length).toBeLessThanOrEqual(10);
			expect(progressCountAtFirstAttempt).toBeGreaterThan(1);
			expect(reportedAttempts.map(({ attempt }) => attempt)).toEqual(result.attempts);
			expect(reportedAttempts.map(({ attemptIndex }) => attemptIndex)).toEqual(
				result.attempts.map((_, attemptIndex) => attemptIndex),
			);
			expect(new Set(progressReports.map(({ total }) => total))).toEqual(new Set([10 * FRAME_COUNT * 4]));

			for (let reportIndex = 0; reportIndex < progressReports.length; reportIndex++) {
				const report = progressReports[reportIndex];
				const previous = progressReports[reportIndex - 1];

				expect(report?.done).toBeGreaterThanOrEqual(previous?.done ?? 0);
				expect(report?.done).toBeLessThanOrEqual(report?.total ?? 0);
			}

			expect(result.bestSmoothedEnvelopeBuffer.frames).toBe(FRAME_COUNT);
			expect(result.winnerOutputLufs).not.toBeNull();
			expect(Math.abs((result.winnerOutputLufs ?? Infinity) - targetLufs)).toBeLessThan(0.5);

			const firstLimitDb = result.attempts[0]?.limitDb;

			expect(firstLimitDb).toBeDefined();
			expect(result.bestLimitDb).toBe(firstLimitDb);

			for (const attempt of result.attempts) {
				expect(attempt.limitDb).toBe(firstLimitDb);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"explicit limitAutoDb sets a fixed limit and B converges against it",
		async () => {
			const source = makeSyntheticSource(0xfade_dead, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);

			const targetLufs = Math.round((metrics.integratedLufs + 2) * 10) / 10;
			const targetTp = metrics.truePeakDb;
			const pivotDb = -30;
			const limitAutoDb = metrics.truePeakDb - 2;

			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb },
				smoothingMs: 1,
				targetLufs,
				targetTp,
				limitAutoDb,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance: 0.5,
				neverExpand: false,
				histogram,
			});

			trackResultBuffers(result);

			expect(result.bestLimitDb).toBeCloseTo(limitAutoDb, 6);
			expect(result.attempts.length).toBeGreaterThan(0);
			for (const attempt of result.attempts) {
				expect(attempt.limitDb).toBeCloseTo(limitAutoDb, 6);
			}

			expect(result.bestSmoothedEnvelopeBuffer.frames).toBe(FRAME_COUNT);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"limitAutoDb = +Infinity falls back to sourcePeakDb (no limit)",
		async () => {
			const source = makeSyntheticSource(0xcafe_f00d, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);

			const targetLufs = Math.round((metrics.integratedLufs + 3) * 10) / 10;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -30 },
				smoothingMs: 1,
				targetLufs,
				targetTp: undefined,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance: 0.5,
				neverExpand: false,
				histogram,
			});

			trackResultBuffers(result);

			expect(result.bestLimitDb).toBe(metrics.truePeakDb);
			expect(result.attempts.length).toBeGreaterThan(0);
			for (const attempt of result.attempts) {
				expect(attempt.limitDb).toBe(metrics.truePeakDb);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"bestSmoothedEnvelopeBuffer is exactly `frames` base-rate samples (single attempt, multi-chunk fixture)",
		async () => {
			const source = makeSyntheticSource(0xcafe_f00d, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);

			const targetLufs = Math.round((metrics.integratedLufs + 3) * 10) / 10;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -10 },
				smoothingMs: 1,
				targetLufs,
				targetTp: undefined,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 1,
				tolerance: 0.5,
				neverExpand: false,
				histogram,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBe(1);
			expect(result.bestSmoothedEnvelopeBuffer.frames).toBe(FRAME_COUNT);

			await result.bestSmoothedEnvelopeBuffer.reset();
			const envelopeChunk = await result.bestSmoothedEnvelopeBuffer.read(
				result.bestSmoothedEnvelopeBuffer.frames,
			);
			const envelope = envelopeChunk.samples[0] ?? new Float32Array(0);

			expect(envelope.length).toBe(FRAME_COUNT);

			let allFinite = true;
			let allPositive = true;
			let minValue = Infinity;
			let maxValue = -Infinity;

			for (let upIdx = 0; upIdx < envelope.length; upIdx++) {
				const value = envelope[upIdx]!;

				if (!Number.isFinite(value)) allFinite = false;
				if (!(value > 0)) allPositive = false;
				if (value < minValue) minValue = value;
				if (value > maxValue) maxValue = value;
			}

			expect(allFinite).toBe(true);
			expect(allPositive).toBe(true);
			expect(minValue).toBeGreaterThan(0);
			expect(maxValue).toBeLessThan(50);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"neverExpand false sets every attempt peakGainDb to effectiveTargetTp − limitDb",
		async () => {
			const source = makeSyntheticSource(0xfeed_face, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);
			const targetLufs = Math.round((metrics.integratedLufs + 2) * 10) / 10;
			const targetTp = metrics.truePeakDb - 1;
			const pivotDb = -30;
			const limitAutoDb = metrics.truePeakDb - 2;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb },
				smoothingMs: 1,
				targetLufs,
				targetTp,
				limitAutoDb,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance: 0.5,
				neverExpand: false,
				histogram,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBeGreaterThan(0);

			const assignedPeakGainDb = targetTp - result.bestLimitDb;

			for (const attempt of result.attempts) {
				expect(attempt.peakGainDb).toBe(assignedPeakGainDb);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"neverExpand true on a downward pair assigns peakGainDb = B when B ≤ tpCap and lands in the box",
		async () => {
			const source = makeSyntheticSource(0xabc_def, 0.8, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);
			const targetLufs = Math.round((metrics.integratedLufs - 3) * 10) / 10;
			const targetTp = metrics.truePeakDb - 2;
			const tolerance = 0.5;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -30 },
				smoothingMs: 1,
				targetLufs,
				targetTp,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance,
				neverExpand: true,
				histogram,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBeGreaterThan(0);

			const tpCap = targetTp - result.bestLimitDb;

			for (const attempt of result.attempts) {
				if (attempt.boost <= tpCap) {
					expect(attempt.peakGainDb).toBe(attempt.boost);
				}
			}

			expect(result.winnerOutputLufs).not.toBeNull();
			expect(Math.abs((result.winnerOutputLufs ?? Infinity) - targetLufs)).toBeLessThan(tolerance);
			expect(result.winnerOutputTruePeakDb).not.toBeNull();
			expect(result.winnerOutputTruePeakDb ?? Infinity).toBeLessThanOrEqual(targetTp);
		},
		TEST_TIMEOUT_MS,
	);

	it("a legal attempt beats an illegal one even when the illegal |lufsErr| is smaller", () => {
		const targetLufs = -21;
		const effectiveTargetTp = -1;
		const illegalCloser = {
			outputLufs: -20.9,
			outputTruePeakDb: -1.2,
			lufsErr: 0.1,
		};
		const legalFarther = {
			outputLufs: -21.8,
			outputTruePeakDb: -2.4,
			lufsErr: -0.8,
		};

		expect(attemptBeatsWinner(legalFarther, illegalCloser, targetLufs, effectiveTargetTp)).toBe(true);
		expect(attemptBeatsWinner(illegalCloser, legalFarther, targetLufs, effectiveTargetTp)).toBe(false);
	});

	it(
		"omitted targetTp uses sourcePeakDb as the TP ceiling",
		async () => {
			const source = makeSyntheticSource(0x1111_2222, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);
			const targetLufs = Math.round((metrics.integratedLufs + 2) * 10) / 10;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -30 },
				smoothingMs: 1,
				targetLufs,
				targetTp: undefined,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance: 0.5,
				neverExpand: false,
				histogram,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBeGreaterThan(0);
			expect(result.bestLimitDb).toBe(metrics.truePeakDb);

			const assignedPeakGainDb = metrics.truePeakDb - result.bestLimitDb;

			for (const attempt of result.attempts) {
				expect(attempt.peakGainDb).toBe(assignedPeakGainDb);
			}

			expect(result.winnerOutputTruePeakDb).not.toBeNull();
			expect(result.winnerOutputTruePeakDb ?? Infinity).toBeLessThanOrEqual(metrics.truePeakDb);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"converged is false when the winner is the lowest-LUFS TP-holding fallback",
		async () => {
			const source = makeSyntheticSource(0x3333_4444, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);
			const targetLufs = -80;
			const targetTp = metrics.truePeakDb;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -30 },
				smoothingMs: 1,
				targetLufs,
				targetTp,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 6,
				tolerance: 0.5,
				neverExpand: true,
				histogram,
			});

			trackResultBuffers(result);

			expect(result.converged).toBe(false);
			expect(result.winnerOutputTruePeakDb).not.toBeNull();
			expect(result.winnerOutputTruePeakDb ?? Infinity).toBeLessThanOrEqual(targetTp);
			expect(result.winnerOutputLufs).not.toBeNull();
			expect(result.winnerOutputLufs ?? -Infinity).toBeGreaterThan(targetLufs);

			const tpHolding = result.attempts.filter((attempt) => attempt.outputTruePeakDb <= targetTp);
			const lowestLufs = Math.min(...tpHolding.map((attempt) => attempt.outputLufs));

			expect(result.winnerOutputLufs).toBe(lowestLufs);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"Tim-on anchors land a legal neverExpand winner with peakGainDb === B",
		async () => {
			const source = makeSyntheticSource(0x269_0001, 0.8, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);
			const histogram = await histogramOf(buffer, 1);
			const floorDb = -41.3319;
			const pivotDb = -21.2362;
			const limitDb = clampLimit(+0.1177, pivotDb, metrics.truePeakDb);
			const targetLufs = -21;
			const targetTp = -1;
			const tolerance = 0.5;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb, pivotDb },
				smoothingMs: 1,
				targetLufs,
				targetTp,
				limitDbOverride: limitDb,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance,
				neverExpand: true,
				histogram,
			});

			trackResultBuffers(result);

			const winner = result.attempts.find(
				(attempt) => attempt.boost === result.bestB && attempt.peakGainDb === result.bestPeakGainDb,
			);

			expect(winner).toBeDefined();
			expect(winner?.outputLufs ?? Infinity).toBeLessThanOrEqual(targetLufs);
			expect(winner?.outputTruePeakDb ?? Infinity).toBeLessThanOrEqual(targetTp);
			expect(Math.abs(winner?.lufsErr ?? Infinity)).toBeLessThan(tolerance);
			expect(Math.abs((winner?.peakGainDb ?? Infinity) - (winner?.boost ?? -Infinity))).toBeLessThan(1e-6);
		},
		TEST_TIMEOUT_MS,
	);
});

/**
 * IIR rate-invariance regression — locks in the 2026-05-13 base-rate-
 * downstream rewrite's claim that `BidirectionalIir` derives its
 * coefficient from `(smoothingMs, sampleRate)` rate-agnostically, so
 * the time-domain response (in milliseconds) of a fixed smoothing
 * constant is identical at base rate and at 4× rate. The pre-rewrite
 * pipeline constructed the IIR at `OVERSAMPLE_FACTOR × baseRate` and
 * stored / applied envelopes at 4×; the rewrite constructs the IIR at
 * `baseRate` and stores / applies at base rate. The two configurations
 * must produce the same time-domain response — only alpha and the
 * per-sample count change.
 */
describe("BidirectionalIir rate invariance (loudness-target smoothing contract)", () => {
	it("step response settles in the same number of MILLISECONDS at base rate and at 4× rate (within ±1 base-sample)", async () => {
		const { BidirectionalIir } = await import("@buffered-audio/utils");
		const smoothingMs = 3; // production-typical
		const baseRate = SAMPLE_RATE; // 48 kHz
		const upRate = baseRate * 4;
		const settleFractionTarget = 0.5;

		// Construct a step input long enough to comfortably reach
		// steady state at both rates. Pre-pad with zero so the IIR
		// state has a clean baseline.
		const baseLength = Math.round((smoothingMs * baseRate) / 1000) * 20; // 20× smoothing
		const upLength = baseLength * 4;
		const baseStep = new Float32Array(baseLength);
		const upStep = new Float32Array(upLength);

		baseStep.fill(1);
		upStep.fill(1);

		// Set the leading sample to 0 so the "step" is well-defined
		// from a clean baseline. Both arrays use the same logical
		// step waveform; only sample count differs.
		baseStep[0] = 0;
		upStep[0] = 0;

		const baseIir = new BidirectionalIir({ smoothingMs, sampleRate: baseRate });
		const upIir = new BidirectionalIir({ smoothingMs, sampleRate: upRate });

		// `applyForwardPass` (single-direction; mirrors the per-chunk
		// forward IIR used inside Walk A). Seed from the first sample
		// at each rate so the leading-edge response is comparable.
		const baseOut = baseIir.applyForwardPass(baseStep, { value: baseStep[0]! });
		const upOut = upIir.applyForwardPass(upStep, { value: upStep[0]! });

		// Find the first index at each rate where the output crosses
		// `settleFractionTarget` (50 % of the asymptote, which is 1).
		// Convert each to milliseconds and assert they match within
		// ±1 base-sample's worth of tolerance — IEEE-754 rounding
		// plus alpha-quantisation can drift by a fraction of a
		// sample between rates, but never more than 1 base-sample at
		// production smoothing values.
		const findSettleIdx = (arr: Float32Array): number => {
			for (let i = 0; i < arr.length; i++) {
				if ((arr[i] ?? 0) >= settleFractionTarget) return i;
			}

			return arr.length;
		};
		const baseSettleIdx = findSettleIdx(baseOut);
		const upSettleIdx = findSettleIdx(upOut);
		const baseSettleMs = (baseSettleIdx / baseRate) * 1000;
		const upSettleMs = (upSettleIdx / upRate) * 1000;
		const toleranceMs = (1 / baseRate) * 1000; // 1 base-sample
		const diffMs = Math.abs(baseSettleMs - upSettleMs);

		expect(diffMs).toBeLessThan(toleranceMs);
	});
});
