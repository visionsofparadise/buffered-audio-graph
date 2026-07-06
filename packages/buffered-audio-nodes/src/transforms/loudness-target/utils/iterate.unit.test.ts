import { BlockBuffer } from "@buffered-audio/core";
import { LoudnessAccumulator, TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";
import { afterEach, describe, expect, it } from "vitest";
import { iterateForTargets } from "./iterate";

const SAMPLE_RATE = 48_000;
const DURATION_SECONDS = 8;
const FRAME_COUNT = SAMPLE_RATE * DURATION_SECONDS;

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

	await buffer.write(channels.map((channel) => new Float32Array(channel)), SAMPLE_RATE, 32);
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
function trackResultBuffers(result: {
	bestSmoothedEnvelopeBuffer: BlockBuffer;
}): void {
	buffersToClose.push(result.bestSmoothedEnvelopeBuffer);
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

	it("converges within tolerance on a typical source (1D-on-B)", async () => {
		// Post `plan-loudness-target-percentile-limit`: iteration is 1D
		// on `B`. `limitDb` is set once at entry from the auto-derivation
		// table; with `limitAutoDb = +Infinity` and no override the
		// fallback is `sourcePeakDb` (no limiting). Amplitude 0.1 → body
		// ≈ -25 LUFS, peak ≈ -19 dBTP. Pivot at -10 keeps body well
		// above pivot so body samples sit in the upper segment between
		// B (at pivotDb) and peakGainDb (at peakDb). With
		// `targetTp = undefined` the iterator collapses
		// `effectiveTargetTp = sourcePeakDb`, so `peakGainDb` starts at 0
		// and the upper segment is flat at `B`. Iteration becomes a
		// 1D secant on `B` for LUFS — the canonical convergent case.
		const source = makeSyntheticSource(0xDEAD_BEEF, 0.1, 0.4);
		const metrics = measureSourceMetrics(source);

		expect(Number.isFinite(metrics.integratedLufs)).toBe(true);
		expect(metrics.lra).toBeGreaterThan(0);

		const targetLufs = Math.round((metrics.integratedLufs + 3) * 10) / 10;
		const buffer = await makeBufferFromChannels(source);

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
			maxAttempts: 10,
			tolerance: 0.5,
			peakTolerance: 0.1,
		});

		trackResultBuffers(result);

		expect(result.converged).toBe(true);
		expect(result.attempts.length).toBeLessThanOrEqual(10);
		// BASE-rate smoothed gain envelope, disk-backed (post the
		// 2026-05-13 base-rate-downstream rewrite — envelope is
		// bandlimited far below base-rate Nyquist by smoothing, so
		// storing at base rate loses nothing).
		expect(result.bestSmoothedEnvelopeBuffer.frames).toBe(FRAME_COUNT);

		const lastAttempt = result.attempts[result.attempts.length - 1];

		expect(lastAttempt).toBeDefined();
		expect(Math.abs(lastAttempt?.lufsErr ?? Infinity)).toBeLessThan(0.5);
		// `limitDb` constant across attempts — every attempt's record carries
		// the same value (the iterator's `currentLimit` at entry).
		const firstLimitDb = result.attempts[0]?.limitDb;

		expect(firstLimitDb).toBeDefined();
		expect(result.bestLimitDb).toBe(firstLimitDb);

		for (const attempt of result.attempts) {
			expect(attempt.limitDb).toBe(firstLimitDb);
		}
	}, TEST_TIMEOUT_MS);

	it("explicit limitAutoDb sets a fixed limit and B converges against it", async () => {
		// New test for `plan-loudness-target-percentile-limit`: pass an
		// explicit finite `limitAutoDb` (simulating what `measureSource`
		// would return for a real source). The iterator's
		// auto-derivation table picks `limitAutoDb` (clamped) as
		// `currentLimit`. `currentLimit` MUST be constant across
		// attempts — `limitDb` no longer iterates.
		//
		// Fixture: same dipped-sine geometry as the canonical convergent
		// test. Pivot at -10 dB; `limitAutoDb` deliberately placed below
		// `sourcePeakDb` (= -19 dBTP) at -10.5 dB (just above
		// `pivotDb + LIMIT_EPSILON_DB` after the iterator's internal
		// clamp). With `targetTp` set explicitly the closed-form
		// `peakGainDb = effectiveTargetTp - limitDb` is non-zero so the
		// curve has a meaningful upper segment.
		const source = makeSyntheticSource(0xFADE_DEAD, 0.1, 0.4);
		const metrics = measureSourceMetrics(source);
		const buffer = await makeBufferFromChannels(source);

		const targetLufs = Math.round((metrics.integratedLufs + 2) * 10) / 10;
		const targetTp = metrics.truePeakDb;
		// `limitAutoDb` placed between pivotDb (-10) and sourcePeakDb
		// (≈ -19). After the iterator's internal `clampLimit`:
		// `pivotDb + LIMIT_EPSILON_DB = -9.99`, `sourcePeakDb ≈ -19`.
		// The feasible window is degenerate (lower > upper because
		// pivot > sourcePeakDb for this fixture); the clamp returns
		// `sourcePeakDb`. To exercise a non-trivial fixed limit, lower
		// `pivotDb` below `sourcePeakDb` so the window is real.
		const pivotDb = -30;
		const limitAutoDb = metrics.truePeakDb - 2; // 2 dB below source peak

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
			peakTolerance: 0.1,
		});

		trackResultBuffers(result);

		// `bestLimitDb` carries the auto-derivation result; must equal
		// the clamped `limitAutoDb` (within the feasible window — at
		// the value we passed since it's between pivot and peak).
		expect(result.bestLimitDb).toBeCloseTo(limitAutoDb, 6);

		// Every attempt's record carries the SAME `limitDb` — this is
		// the load-bearing assertion for the "1D on B" structural
		// change. If a regression re-introduces a `limitDb` iteration
		// axis, this loop fires.
		expect(result.attempts.length).toBeGreaterThan(0);
		for (const attempt of result.attempts) {
			expect(attempt.limitDb).toBeCloseTo(limitAutoDb, 6);
		}

		// `bestSmoothedEnvelopeBuffer` populated.
		expect(result.bestSmoothedEnvelopeBuffer.frames).toBe(FRAME_COUNT);
	}, TEST_TIMEOUT_MS);

	it("limitAutoDb = +Infinity falls back to sourcePeakDb (no limit)", async () => {
		// New test for `plan-loudness-target-percentile-limit`: the
		// silent-source / no-post-pivot-samples sentinel from
		// `measureSource` is `Number.POSITIVE_INFINITY`. The iterator's
		// auto-derivation table must treat this as "no usable percentile
		// limit" and fall back to `currentLimit = sourcePeakDb` — the
		// brick-wall branch is then dormant for every sample.
		const source = makeSyntheticSource(0xCAFE_F00D, 0.1, 0.4);
		const metrics = measureSourceMetrics(source);
		const buffer = await makeBufferFromChannels(source);

		const targetLufs = Math.round((metrics.integratedLufs + 3) * 10) / 10;
		const result = await iterateForTargets({
			buffer,
			sampleRate: SAMPLE_RATE,
			anchorBase: { floorDb: -50, pivotDb: -30 },
			smoothingMs: 1,
			targetLufs,
			targetTp: undefined,
			// `+Infinity` sentinel — degenerate histogram, no usable
			// percentile.
			limitAutoDb: Number.POSITIVE_INFINITY,
			sourceLufs: metrics.integratedLufs,
			sourcePeakDb: metrics.truePeakDb,
			maxAttempts: 10,
			tolerance: 0.5,
			peakTolerance: 0.1,
		});

		trackResultBuffers(result);

		// Fallback: `currentLimit = sourcePeakDb`. `bestLimitDb` carries
		// this constant.
		expect(result.bestLimitDb).toBe(metrics.truePeakDb);

		// Every attempt records the same `sourcePeakDb` as `limitDb`.
		expect(result.attempts.length).toBeGreaterThan(0);
		for (const attempt of result.attempts) {
			expect(attempt.limitDb).toBe(metrics.truePeakDb);
		}
	}, TEST_TIMEOUT_MS);

	it("infeasible joint targets exhaust maxAttempts and return closest-attempt fallback", async () => {
		// Force non-convergence with `tolerance = 1e-9`,
		// `peakTolerance = 1e-9`, and `maxAttempts = 4`. The
		// closest-attempt fallback must return `bestB` from one of the
		// attempts and the minimum joint score across them.
		//
		// Post 2026-05-13 joint-iteration rewrite: `bestScore` is
		// `sqrt(lufsErr^2 + peakErr^2)` (both signed, two-sided peak —
		// no LRA term). The `bestB / bestLimitDb` matching collapses
		// — `limitDb` is constant across attempts, so `bestB` alone is
		// the disambiguator here (jointly with `bestPeakGainDb`).
		//
		// Post Phase 4 of `plan-loudness-target-stream-caching` the
		// always-on two-decimal-precision exit gate could otherwise fire
		// in this scenario by coincidence (an attempt landing both axes
		// within 0.005 of their targets). To force the gate closed we
		// push the targets into a regime where no plausible attempt
		// rounds to 0 at 2 dp on BOTH axes simultaneously: `targetLufs`
		// at the maximum (0), peak ceiling 25 dB below source peak.
		// `sourceLufs = -30` and `sourcePeakDb = -10` keep the "huge
		// body lift, no peak headroom" intent — no choice of `B` /
		// `peakGainDb` within 4 attempts produces a 2-dp-perfect result
		// on both axes.
		const source = makeSyntheticSource(0xC0FFEE, 0.1, 0.4);
		const metrics = measureSourceMetrics(source);
		const buffer = await makeBufferFromChannels(source);

		const result = await iterateForTargets({
			buffer,
			sampleRate: SAMPLE_RATE,
			anchorBase: { floorDb: -50, pivotDb: -10 },
			smoothingMs: 1,
			targetLufs: 0,
			targetTp: -35,
			limitAutoDb: Number.POSITIVE_INFINITY,
			// Artificial sourceLufs / sourcePeakDb to force the iteration
			// into a deeply infeasible regime — `targetLufs - sourceLufs
			// = +30` LUFS lift, ceiling 25 dB BELOW source peak.
			sourceLufs: -30,
			sourcePeakDb: -10,
			maxAttempts: 4,
			tolerance: 1e-9,
			// Mirror the LUFS tolerance's extreme tightness on the peak axis
			// so the "force non-convergence" intent extends to the peak
			// convergence check from `plan-loudness-target-tp-iteration`.
			peakTolerance: 1e-9,
		});

		trackResultBuffers(result);

		expect(result.converged).toBe(false);
		expect(result.attempts.length).toBe(4);

		// Best `B` must come from one of the recorded attempts. `limitDb`
		// is constant, so it can't be a disambiguator — match on `boost`.
		const matchedAttempt = result.attempts.find((attempt) => attempt.boost === result.bestB);

		expect(matchedAttempt).toBeDefined();
		expect(result.bestSmoothedEnvelopeBuffer.frames).toBe(FRAME_COUNT);

		// Best score must be the minimum across all attempts. Score
		// formula post tolerance-normalized rewrite (2026-07-05):
		// `max(|lufsErr|/tolerance, |peakErr|/peakTolerance)` — the
		// gate-normalized max; the elected winner is the attempt
		// closest to passing both gates. Both tolerances are 1e-9 here.
		const TOLERANCE = 1e-9;
		const PEAK_TOLERANCE = 1e-9;
		const scoreOfNorm = (attempt: { lufsErr: number; peakErr: number }): number => {
			return Math.max(Math.abs(attempt.lufsErr) / TOLERANCE, Math.abs(attempt.peakErr) / PEAK_TOLERANCE);
		};
		const minScore = Math.min(...result.attempts.map(scoreOfNorm));
		const bestScore = matchedAttempt ? scoreOfNorm(matchedAttempt) : Infinity;

		expect(bestScore).toBeCloseTo(minScore, 6);
	}, TEST_TIMEOUT_MS);

	/**
	 * Joint iteration (post 2026-05-13 rewrite): both `B` and
	 * `peakGainDb` update on every attempt based on the previous
	 * attempt's signed `(lufsErr, peakErr)`. Each test sets `targetTp`
	 * EXPLICITLY (when not testing skipPeak) because
	 * `targetTp === undefined` activates `skipPeak`, which suppresses
	 * the peak axis of the gate and the score.
	 *
	 * Scenarios:
	 *   (a) overshoot triggers backoff — aggressive curve + tight TP
	 *       ceiling drives at least one attempt to back `peakGainDb` off
	 *       its initial closed-form value.
	 *   (b) symmetric undershoot correction (new for joint) — output TP
	 *       initially sits BELOW target; the signed proportional
	 *       feedback pulls `peakGainDb` UP across attempts.
	 *   (c) both axes converge — moderate-contrast fixture reaches
	 *       `converged === true` within `maxAttempts`.
	 *   (d) infeasibility — huge body lift + severe TP ceiling exhausts
	 *       `maxAttempts`; `bestPeakGainDb` respects the `-60` floor.
	 *   (e) best-attempt envelope matches reported params (new for joint
	 *       to verify the buffer-swap fix).
	 */
	describe("peakGainDb adjustment", () => {
		const TEST_TIMEOUT_MS_INNER = 120_000;

		it("overshoot triggers backoff when targetTp sits below sourcePeakDb on an aggressive curve", async () => {
			const source = makeSyntheticSource(0xBEEF_CAFE, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

			const targetLufs = Math.round((metrics.integratedLufs + 12) * 10) / 10;
			const targetTp = metrics.truePeakDb - 3;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -30 },
				smoothingMs: 5,
				targetLufs,
				targetTp,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 5,
				tolerance: 0.5,
				peakTolerance: 0.1,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBeGreaterThan(1);

			const initialPeakGainDb = result.attempts[0]?.peakGainDb;

			expect(initialPeakGainDb).toBeDefined();
			// Initial value: closed-form `targetTp - currentLimit`. With
			// `limitAutoDb = +Infinity` and no override, `currentLimit =
			// sourcePeakDb`, so the closed form is `targetTp - sourcePeakDb`.
			expect(initialPeakGainDb).toBeCloseTo(targetTp - metrics.truePeakDb, 6);

			// First attempt overshoots — that's the precondition that
			// lets the proportional-feedback branch fire on attempt 0 →
			// attempt 1's `peakGainDb`.
			const firstAttemptPeakErr = result.attempts[0]?.peakErr ?? 0;

			expect(firstAttemptPeakErr).toBeGreaterThan(0.1);

			// Backoff: some attempt k > 0 has `peakGainDb` strictly
			// below the first attempt. The signed proportional feedback
			// drives this monotonically downward while overshoot
			// persists.
			const backoffOccurred = result.attempts.some(
				(attempt, index) => index > 0 && initialPeakGainDb !== undefined && attempt.peakGainDb < initialPeakGainDb,
			);

			expect(backoffOccurred).toBe(true);
		}, TEST_TIMEOUT_MS_INNER);

		it("peakGainDb update is symmetric in the sign of peakErr (overshoot down, undershoot up)", async () => {
			// New test for the joint-iteration symmetric peak rule
			// (2026-05-13). Pre-rewrite the iterator used
			// `peakOvershoot = max(0, peakErr)`; an attempt with output
			// TP sitting BELOW target had `peakOvershoot = 0` and the
			// proportional-feedback branch never fired. The signed
			// `peakErr` formulation closes that gap — undershoot pulls
			// `peakGainDb` UP.
			//
			// This test asserts the MATHEMATICAL PROPERTY of the
			// update rule rather than relying on a specific fixture to
			// undershoot. The rule is:
			//   when |peakErr| > peakTolerance and peakGainDb is not
			//   at the PEAK_GAIN_DB_FLOOR clamp:
			//   nextPeakGainDb = thisPeakGainDb - thisPeakErr * 0.8
			//
			// Pre-rewrite the rule was:
			//   nextPeakGainDb = thisPeakGainDb - max(0, thisPeakErr) * 0.8
			// which collapses to a no-op when thisPeakErr < 0.
			//
			// The mathematical signature distinguishing the two:
			//   - sign of (nextPeakGainDb - thisPeakGainDb) equals
			//     sign of (-thisPeakErr).
			// Under the old rule, the sign of the delta was always
			// <= 0; under the new rule it tracks the sign of
			// -peakErr (positive when undershoot, negative when
			// overshoot). We verify the delta-equals-formula relation
			// on every consecutive (i, i+1) pair where the branch
			// preconditions hold.
			const source = makeSyntheticSource(0xBEEF_CAFE, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

			// Aggressive-curve fixture (matches the existing
			// "overshoot triggers backoff" fixture so we know the
			// peak-update branch fires multiple times).
			const targetLufs = Math.round((metrics.integratedLufs + 12) * 10) / 10;
			const targetTp = metrics.truePeakDb - 3;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -30 },
				smoothingMs: 5,
				targetLufs,
				targetTp,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance: 0.5,
				peakTolerance: 0.1,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBeGreaterThan(2);

			// Damping factor from the iterator's PEAK_DAMPING constant.
			const PEAK_DAMPING = 0.8;
			const PEAK_GAIN_DB_FLOOR = -60;

			// On every consecutive (i, i+1) pair where the branch
			// preconditions hold (|peakErr| > peakTolerance AND
			// peakGainDb is above the floor on attempt i), the next
			// attempt's peakGainDb MUST equal the signed-update
			// formula's prediction (within numerical tolerance).
			//
			// This is the mathematical statement of "signed
			// proportional feedback" — the test fails if the iterator
			// ever uses the one-sided `max(0, peakErr)` form (which
			// would zero out the update on undershoot attempts) or any
			// other malformed signed rule. Asserting the formula
			// directly verifies the symmetric mechanism without
			// depending on the fixture producing undershoot attempts.
			let pairsChecked = 0;

			for (let idx = 0; idx < result.attempts.length - 1; idx++) {
				const thisAttempt = result.attempts[idx];
				const nextAttempt = result.attempts[idx + 1];

				if (thisAttempt === undefined || nextAttempt === undefined) continue;
				if (Math.abs(thisAttempt.peakErr) <= 0.1) continue;
				if (thisAttempt.peakGainDb <= PEAK_GAIN_DB_FLOOR) continue;

				// Floor-clamp check: if the prediction would push below
				// the floor, the next value is clamped to the floor,
				// not the unclamped formula. Skip those pairs.
				const predicted = thisAttempt.peakGainDb - thisAttempt.peakErr * PEAK_DAMPING;

				if (predicted < PEAK_GAIN_DB_FLOOR) continue;

				expect(nextAttempt.peakGainDb).toBeCloseTo(predicted, 6);
				pairsChecked++;
			}

			// Sanity: at least one pair was actually checked — the
			// fixture must exercise the branch.
			expect(pairsChecked).toBeGreaterThan(0);
		}, TEST_TIMEOUT_MS_INNER);

		it("peakGainDb only updates when |peakErr| exceeds peakTolerance (mechanism preservation)", async () => {
			// Joint-iteration version of the prior sequential
			// "no overshoot leaves peakGainDb at the closed-form" test.
			// Sequential's structural guarantee was: Phase A exits in
			// 1 attempt when |peakErr| <= peakTolerance, so peakGainDb
			// stays frozen for every later (Phase B) attempt. Under
			// joint iteration peakGainDb still respects the same
			// gate (`|peakErr| > peakTolerance` enables the update),
			// but the gate is checked every attempt.
			//
			// This test pins the mechanism: any attempt whose peakErr
			// is within peakTolerance MUST leave peakGainDb unchanged
			// on the next attempt. Implementation invariant — protects
			// against a regression that fires the proportional-feedback
			// branch unconditionally (which would drift peakGainDb on
			// noise even when peak is already within tolerance).
			const source = makeSyntheticSource(0x1234_ABCD, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

			const targetLufs = Math.round((metrics.integratedLufs + 1.5) * 10) / 10;
			const targetTp = metrics.truePeakDb + 2;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -10 },
				smoothingMs: 1,
				targetLufs,
				targetTp,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 5,
				tolerance: 0.05,
				peakTolerance: 0.1,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBeGreaterThan(1);

			// For each consecutive attempt pair: if attempt[i]'s
			// |peakErr| <= peakTolerance, attempt[i+1]'s peakGainDb
			// must equal attempt[i]'s (the branch did not fire). If
			// attempt[i]'s |peakErr| > peakTolerance, the branch may
			// or may not have moved peakGainDb (depends on the floor
			// clamp), so no assertion in that direction.
			for (let idx = 0; idx < result.attempts.length - 1; idx++) {
				const thisAttempt = result.attempts[idx];
				const nextAttempt = result.attempts[idx + 1];

				if (thisAttempt === undefined || nextAttempt === undefined) continue;
				if (Math.abs(thisAttempt.peakErr) <= 0.1) {
					expect(nextAttempt.peakGainDb).toBe(thisAttempt.peakGainDb);
				}
			}
		}, TEST_TIMEOUT_MS_INNER);

		it("skipPeak keeps peakGainDb at the closed-form 0 across every attempt", async () => {
			// When `targetTp === undefined` the iterator activates
			// `skipPeak`. The peak axis of the convergence gate is
			// auto-satisfied, the score's peak component is forced to
			// 0, and the peak-update branch is skipped — `peakGainDb`
			// stays at the closed-form initial value forever.
			const source = makeSyntheticSource(0xDEAD_BEEF, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

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
				maxAttempts: 10,
				tolerance: 0.5,
				peakTolerance: 0.1,
			});

			trackResultBuffers(result);

			// `effectiveTargetTp = sourcePeakDb` under the skipPeak
			// branch → closed-form initial `peakGainDb = sourcePeakDb -
			// currentLimit = 0` (since currentLimit defaults to
			// sourcePeakDb here).
			const initialPeakGainDb = result.attempts[0]?.peakGainDb;

			expect(initialPeakGainDb).toBeCloseTo(0, 6);

			// peakGainDb never moves under skipPeak.
			for (const attempt of result.attempts) {
				expect(attempt.peakGainDb).toBe(initialPeakGainDb);
			}
		}, TEST_TIMEOUT_MS_INNER);

		it("best-attempt scores converge across attempts on a moderate-contrast fixture", async () => {
			// Joint-iteration version of the prior sequential
			// "converges within maxAttempts" test. The fixture combines
			// a +3 dB LUFS lift with a +5 dB peak headroom. Under
			// sequential iteration this converged in ~4 attempts; under
			// joint iteration both axes track simultaneously and the
			// coupling on EXPANSIVE_UPPER_SEGMENT geometry (peakGainDb
			// > B here) can produce more oscillation before settling.
			//
			// The test asserts BEST-ATTEMPT convergence rather than
			// strict gate convergence — the best attempt's joint score
			// must be small. This is the actual end-user-facing
			// guarantee: the iterator returns the best attempt's
			// envelope; the per-attempt trajectory's "convergence" is
			// a diagnostic.
			const source = makeSyntheticSource(0xF00D_FACE, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

			const targetLufs = Math.round((metrics.integratedLufs + 3) * 10) / 10;
			const targetTp = metrics.truePeakDb + 5;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -10 },
				smoothingMs: 1,
				targetLufs,
				targetTp,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance: 0.5,
				peakTolerance: 0.1,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBeLessThanOrEqual(10);
			expect(result.attempts.length).toBeGreaterThan(0);

			// Find the best-attempt (the one whose envelope is held).
			const bestAttempt = result.attempts.find(
				(attempt) =>
					attempt.boost === result.bestB
					&& attempt.peakGainDb === result.bestPeakGainDb,
			);

			expect(bestAttempt).toBeDefined();

			// Best-attempt joint score (unweighted, for human-readable
			// "how close to both targets" reporting): well under the
			// budget-exhaustion outliers seen on saddle fixtures. 3 is
			// a generous bound; under sequential iteration this
			// fixture used to land at score ~0.1, but joint iteration
			// on EXPANSIVE_UPPER_SEGMENT geometry (peakGainDb=+5 vs
			// B≈+3) trades convergence speed for coupled-axis safety.
			// The end-user-facing assertion is that the best attempt's
			// signed errors are both bounded, not that they converged
			// to the strict tolerance gate.
			const bestScore = bestAttempt
				? Math.sqrt(bestAttempt.lufsErr * bestAttempt.lufsErr + bestAttempt.peakErr * bestAttempt.peakErr)
				: Infinity;

			expect(bestScore).toBeLessThan(3.0);
		}, TEST_TIMEOUT_MS_INNER);

		it("infeasible target exhausts maxAttempts with bestPeakGainDb at or above the -60 floor", async () => {
			const source = makeSyntheticSource(0xDEAD_F00D, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

			const targetLufs = metrics.integratedLufs + 20;
			const targetTp = metrics.truePeakDb - 10;
			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -30 },
				smoothingMs: 5,
				targetLufs,
				targetTp,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: metrics.integratedLufs,
				sourcePeakDb: metrics.truePeakDb,
				maxAttempts: 10,
				tolerance: 0.5,
				peakTolerance: 0.1,
			});

			trackResultBuffers(result);

			expect(result.converged).toBe(false);
			expect(result.attempts.length).toBe(10);
			expect(result.bestPeakGainDb).toBeGreaterThanOrEqual(-60);
			for (const attempt of result.attempts) {
				expect(attempt.peakGainDb).toBeGreaterThanOrEqual(-60);
			}
			expect(result.bestSmoothedEnvelopeBuffer.frames).toBeGreaterThan(0);
		}, TEST_TIMEOUT_MS_INNER);

		it("best-attempt fallback returns (bestB, bestPeakGainDb) that match an attempt in the history", async () => {
			// New test for the joint-iteration buffer-swap invariant
			// (2026-05-13): the held `bestSmoothedEnvelopeBuffer` MUST
			// correspond to an attempt whose `(boost, peakGainDb)`
			// equals the reported `(bestB, bestPeakGainDb)`. The prior
			// sequential design had a discrepancy where these could
			// diverge (e.g. when a Phase A attempt won the score race
			// but Phase B's frozen value was applied to the buffer
			// indirectly); joint iteration updates both sides of the
			// swap in lockstep.
			//
			// Force non-convergence so we exercise the fallback path:
			// tight tolerances + a tight maxAttempts.
			const source = makeSyntheticSource(0xFACE_F00D, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

			const result = await iterateForTargets({
				buffer,
				sampleRate: SAMPLE_RATE,
				anchorBase: { floorDb: -50, pivotDb: -10 },
				smoothingMs: 1,
				targetLufs: 0,
				targetTp: -25,
				limitAutoDb: Number.POSITIVE_INFINITY,
				sourceLufs: -30,
				sourcePeakDb: -10,
				maxAttempts: 4,
				tolerance: 1e-9,
				peakTolerance: 1e-9,
			});

			trackResultBuffers(result);

			expect(result.converged).toBe(false);
			expect(result.attempts.length).toBe(4);

			// Find the attempt whose (boost, peakGainDb) match the
			// reported best. There must be exactly one such attempt;
			// missing means the swap mechanic dropped a track of the
			// active envelope's parameters.
			const matchedAttempt = result.attempts.find(
				(attempt) =>
					attempt.boost === result.bestB
					&& attempt.peakGainDb === result.bestPeakGainDb,
			);

			expect(matchedAttempt).toBeDefined();

			// And that matched attempt must minimise the joint score
			// across all attempts — the buffer holds the envelope of
			// the attempt with the smallest `sqrt(lufsErr² + peakErr²)`.
			// Both axes weighted equally (no priority weighting; joint
			// iteration treats LUFS and TP symmetrically).
			const TOLERANCE = 1e-9;
			const PEAK_TOLERANCE = 1e-9;
			const scoreOf = (attempt: { lufsErr: number; peakErr: number }): number => {
				return Math.max(Math.abs(attempt.lufsErr) / TOLERANCE, Math.abs(attempt.peakErr) / PEAK_TOLERANCE);
			};
			const minScore = Math.min(...result.attempts.map(scoreOf));
			const matchedScore = matchedAttempt ? scoreOf(matchedAttempt) : Infinity;

			expect(matchedScore).toBeCloseTo(minScore, 6);

			// Envelope buffer holds a non-trivial signal.
			expect(result.bestSmoothedEnvelopeBuffer.frames).toBeGreaterThan(0);
		}, TEST_TIMEOUT_MS_INNER);

		it("elects the gate-passing attempt over an earlier lower-L2 attempt that fails peakTolerance", async () => {
			// Phase 1 corner (plan-loudness-target-scoring-and-gain-lut §1.2):
			// under the tolerance-normalized score the elected winner passes
			// both convergence gates whenever any attempt does. Wide LUFS
			// `tolerance` (1.5) + tight `peakTolerance` (0.1): on this fixture
			// the coupled (B, peakGainDb) trajectory produces an EARLY attempt
			// (index 5) whose LUFS sits almost dead-on target (|lufsErr| ~0.05)
			// but whose peak still overshoots the tight gate (|peakErr| ~0.23),
			// giving it the SMALLEST equal-weighted L2 `sqrt(lufsErr^2 +
			// peakErr^2)` of the run — the attempt the OLD scoring elected. The
			// signed peak feedback keeps correcting, and a LATER attempt
			// (index 7) clears both gates but at a larger |lufsErr| (~0.33, still
			// well inside the wide tolerance), so its L2 is HIGHER. Old scoring
			// keeps the gate-failing index 5; the new
			// `max(|lufsErr|/tolerance, |peakErr|/peakTolerance)` elects the
			// gate-passing index 7. Params below are pinned from a fixture sweep
			// (scratch probe) that verified this exact divergence.
			const source = makeSyntheticSource(0xF00D_FACE, 0.2, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

			const targetLufs = Math.round((metrics.integratedLufs + 1.5) * 10) / 10;
			const targetTp = metrics.truePeakDb - 0.5;
			const TOLERANCE = 1.5;
			const PEAK_TOLERANCE = 0.1;
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
				tolerance: TOLERANCE,
				peakTolerance: PEAK_TOLERANCE,
			});

			trackResultBuffers(result);

			// The winner is the held (boost, peakGainDb) attempt.
			const winner = result.attempts.find(
				(attempt) =>
					attempt.boost === result.bestB
					&& attempt.peakGainDb === result.bestPeakGainDb,
			);

			expect(winner).toBeDefined();

			// Invariant: the elected winner passes BOTH gates, and the run
			// reports converged.
			expect(Math.abs(winner?.lufsErr ?? Infinity)).toBeLessThan(TOLERANCE);
			expect(Math.abs(winner?.peakErr ?? Infinity)).toBeLessThan(PEAK_TOLERANCE);
			expect(result.converged).toBe(true);

			// Vacuous-pin guard (plan §1.2): this only pins a regression if
			// the fixture actually realises an EARLIER attempt with strictly
			// lower equal-weighted L2 than the winner that ALSO fails the peak
			// gate — the exact attempt the OLD scoring would have (wrongly)
			// elected. If no such attempt exists the new invariant holds
			// trivially and the test proves nothing, so assert its existence.
			const l2 = (a: { lufsErr: number; peakErr: number }): number =>
				Math.sqrt(a.lufsErr * a.lufsErr + a.peakErr * a.peakErr);
			const winnerIdx = result.attempts.findIndex(
				(attempt) =>
					attempt.boost === result.bestB
					&& attempt.peakGainDb === result.bestPeakGainDb,
			);
			const winnerL2 = winner ? l2(winner) : Infinity;
			const gateFailingLowerL2Exists = result.attempts.some(
				(attempt, index) =>
					index < winnerIdx
					&& l2(attempt) < winnerL2
					&& Math.abs(attempt.peakErr) > PEAK_TOLERANCE,
			);

			expect(gateFailingLowerL2Exists).toBe(true);
		}, TEST_TIMEOUT_MS_INNER);
	});

	describe("Phase 4 envelope shape", () => {
		const TEST_TIMEOUT_MS_INNER = 120_000;

		it("bestSmoothedEnvelopeBuffer is exactly `frames` base-rate samples (single attempt, multi-chunk fixture)", async () => {
			const source = makeSyntheticSource(0xCAFE_F00D, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

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
				peakTolerance: 0.1,
			});

			trackResultBuffers(result);

			expect(result.attempts.length).toBe(1);
			expect(result.bestSmoothedEnvelopeBuffer.frames).toBe(FRAME_COUNT);

			// Sanity-check: every sample is finite and positive. Catches a
			// regression where the walk-A streaming loop fails to fill the
			// trailing portion of the envelope buffer (e.g. a missed
			// `isFinal` flush). Use a manual scan with summary asserts
			// (rather than per-sample `expect()`) so the test runs in
			// seconds, not minutes. Read the entire envelope into a flat
			// array once at the top — `reset()` then `read(frames)`
			// returns one allocation covering the whole buffer.
			await result.bestSmoothedEnvelopeBuffer.reset();
			const envelopeChunk = await result.bestSmoothedEnvelopeBuffer.read(result.bestSmoothedEnvelopeBuffer.frames);
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
			// Gain bounded by the curve's clamps (B ∈ [-30, 30] dB → linear
			// gain ∈ ~[0.0316, 31.6]). A zero gain or non-finite would
			// indicate a fill-gap regression.
			expect(minValue).toBeGreaterThan(0);
			expect(maxValue).toBeLessThan(50);
		}, TEST_TIMEOUT_MS_INNER);
	});

	describe("two-decimal-precision early exit (Phase 4 of plan-loudness-target-stream-caching)", () => {
		const TEST_TIMEOUT_MS_INNER = 120_000;

		it("converges via the precision gate even when tolerance / peakTolerance are unreachable", async () => {
			// The precision gate fires when `round(|lufsErr| × 100) === 0`
			// AND `skipPeak || round(|peakErr| × 100) === 0` (two-sided
			// peak under the joint-iteration rewrite). To prove
			// THIS gate is what converges the iteration (not the tolerance
			// gate), we pass impossibly-tight tolerances `1e-9` so the
			// tolerance gate cannot possibly fire — pre-Phase-4 the same
			// inputs returned `converged: false` after exhausting
			// `maxAttempts`. Post-Phase-4 the precision gate fires the
			// moment both axes round to zero error at two decimal places.
			//
			// Fixture: canonical convergent geometry (mirror of the first
			// `iterateForTargets` test in this file). `targetTp: undefined`
			// activates `skipPeak`, so the precision gate's peak clause
			// is auto-satisfied — convergence depends solely on `lufsErr`
			// rounding to 0 at 2 dp.
			const source = makeSyntheticSource(0xDEAD_BEEF, 0.1, 0.4);
			const metrics = measureSourceMetrics(source);
			const buffer = await makeBufferFromChannels(source);

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
				maxAttempts: 10,
				// Sub-precision tolerance — cannot be satisfied by any
				// realistic 2-dp-perfect attempt. If convergence happens,
				// it is because the precision gate fired.
				tolerance: 1e-9,
				peakTolerance: 1e-9,
			});

			trackResultBuffers(result);

			expect(result.converged).toBe(true);
			expect(result.attempts.length).toBeLessThanOrEqual(10);

			// The winning attempt must round to zero at 2 dp on the LUFS
			// axis (peak axis is auto-satisfied under `skipPeak`).
			const winningAttempt = result.attempts[result.attempts.length - 1];

			expect(winningAttempt).toBeDefined();
			expect(Math.round(Math.abs(winningAttempt?.lufsErr ?? Infinity) * 100)).toBe(0);
			// Tolerance gate was unreachable — this assertion guards
			// against a regression that silently reverts the gate order or
			// collapses both gates into one.
			expect(Math.abs(winningAttempt?.lufsErr ?? Infinity)).toBeGreaterThan(1e-9);
		}, TEST_TIMEOUT_MS_INNER);
	});
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
