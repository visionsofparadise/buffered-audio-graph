/* eslint-disable no-console -- the node logs an iteration summary by design; tests run with vitest, console output is fine in CI. */
import { describe, expect, it } from "vitest";
import { LoudnessAccumulator, TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";
import type { Block } from "@buffered-audio/core";
import { createTestSetupContext, createTestStreamContext, readableFrom } from "@buffered-audio/core/testing";
import { loudnessTarget, LoudnessTargetStream } from ".";

const TEST_SAMPLE_RATE = 48_000;
const TEST_FRAMES = TEST_SAMPLE_RATE * 4; // 4 s — long enough for BS.1770 gating.
const TEST_FRAMES_LRA = TEST_SAMPLE_RATE * 10; // 10 s — needed for LRA ≥ 2 short-term blocks at meaningful limitDb.

function measureLufs(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const accumulator = new LoudnessAccumulator(sampleRate, channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return accumulator.finalize().integrated;
}

function measureTruePeak(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const accumulator = new TruePeakAccumulator(sampleRate, channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return linearToDb(accumulator.finalize());
}

/**
 * Deterministic synthetic source. Low-frequency sine + small high-
 * frequency sine + LCG-seeded white noise; broadband body lands in a
 * sane voice/podcast LUFS range at amplitude 0.1 (peak ≈ 0.12).
 *
 * sourceLufs ≈ -25, sourcePeakDb ≈ -18, sourceLra ≈ 0 (steady amplitude).
 */
function makeSynthetic(frames: number, sampleRate: number, seed = 1): Float32Array {
	const out = new Float32Array(frames);
	let state = seed >>> 0;

	for (let index = 0; index < frames; index++) {
		state = (state * 1664525 + 1013904223) >>> 0;

		const noise = (state / 0xffffffff - 0.5) * 0.05;
		const fundamental = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.08;
		const harmonic = Math.sin((2 * Math.PI * 880 * index) / sampleRate) * 0.02;

		out[index] = fundamental + harmonic + noise;
	}

	return out;
}

/**
 * Dynamic synthetic source for the LRA test. Linear amplitude ramp
 * from `lowAmp` to `highAmp` across the full duration, plus 220 Hz
 * sine + LCG noise. With (0.001 → 0.5) over 10 s this lands at
 * sourceLra ≈ 10–11 LU — enough headroom to compress down to a
 * targetLra of 8 without saturating the monotonicity bound.
 *
 * The plan's `makeSynthetic` is steady-amplitude and produces
 * sourceLra ≈ 0; per Phase 3's forwarded LRA-controllability concern,
 * Phase 4.1's LRA assertion needs a fixture with measurable LRA in the
 * first place.
 */
function makeRamp(frames: number, sampleRate: number, lowAmp: number, highAmp: number, seed = 1): Float32Array {
	const out = new Float32Array(frames);
	let state = seed >>> 0;

	for (let index = 0; index < frames; index++) {
		state = (state * 1664525 + 1013904223) >>> 0;

		const noise = (state / 0xffffffff - 0.5) * 0.05;
		const fundamental = Math.sin((2 * Math.PI * 220 * index) / sampleRate);
		const t = index / frames;
		const amp = lowAmp + (highAmp - lowAmp) * t;

		out[index] = amp * (fundamental + noise);
	}

	return out;
}

interface TargetRunOptions {
	targetLufs: number;
	pivot?: number;
	floor?: number;
	targetTp?: number;
	limitDb?: number;
	limitPercentile?: number;
	smoothing?: number;
	tolerance?: number;
	peakTolerance?: number;
	maxAttempts?: number;
}

/**
 * Outcome of a `runStream` call: the per-channel transformed output
 * plus the diagnostic `winningB` / `winningLimitDb` from the
 * iteration. Tests that need to assert on iteration behaviour read
 * these fields. The fields are private on `LoudnessTargetStream`; the
 * type cast in `runStream` is the only place we reach into them.
 */
interface RunStreamResult {
	channels: Array<Float32Array>;
	winningB: number | null;
	winningLimitDb: number | null;
}

/**
 * Drive the LoudnessTargetStream end-to-end as a single chunk. Also
 * exposes the iteration's winning `(B, limitDb)` for tests that need to
 * assert on iteration behaviour.
 */
async function runStream(channels: ReadonlyArray<Float32Array>, sampleRate: number, properties: TargetRunOptions): Promise<RunStreamResult> {
	const channelCount = channels.length;
	const stream = new LoudnessTargetStream(loudnessTarget({
		targetLufs: properties.targetLufs,
		pivot: properties.pivot,
		floor: properties.floor,
		targetTp: properties.targetTp,
		limitDb: properties.limitDb,
		limitPercentile: properties.limitPercentile ?? 0.995,
		smoothing: properties.smoothing ?? 1,
		tolerance: properties.tolerance ?? 0.5,
		peakTolerance: properties.peakTolerance ?? 0.1,
		maxAttempts: properties.maxAttempts ?? 10,
	}), createTestStreamContext().context);

	const samples: Array<Float32Array> = [];

	for (const channel of channels) samples.push(channel);

	const chunk: Block = { samples, offset: 0, sampleRate, bitDepth: 32 };
	const output = await stream.setup(readableFrom([chunk]), createTestSetupContext());
	const reader = output.getReader();

	const collected: Array<Array<Float32Array>> = [];

	for (;;) {
		const next = await reader.read();

		if (next.done) break;

		collected.push(next.value.samples);
	}

	const lengths = new Array<number>(channelCount).fill(0);

	for (const piece of collected) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			lengths[channelIndex] = (lengths[channelIndex] ?? 0) + (piece[channelIndex]?.length ?? 0);
		}
	}

	const out: Array<Float32Array> = [];

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		out.push(new Float32Array(lengths[channelIndex] ?? 0));
	}

	const offsets = new Array<number>(channelCount).fill(0);

	for (const piece of collected) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const slice = piece[channelIndex];

			if (!slice) continue;

			out[channelIndex]?.set(slice, offsets[channelIndex] ?? 0);
			offsets[channelIndex] = (offsets[channelIndex] ?? 0) + slice.length;
		}
	}

	const diagnostics = stream as unknown as { winningB: number | null; winningLimitDb: number | null };

	return { channels: out, winningB: diagnostics.winningB, winningLimitDb: diagnostics.winningLimitDb };
}

describe("LoudnessTarget end-to-end", () => {
	it("min-config: auto-pivot + percentile-derived limit converges (1D on B)", async () => {
		// Minimum-config call: only `targetLufs`. No `pivot` (auto-derived
		// from `median(considered LRA blocks)`). No `floor`. No
		// `limitDb` override (the iterator picks the percentile-derived
		// `limitAutoDb` from `measureSource`'s top-down walk over the
		// 4×-rate detection-envelope histogram with `limitPercentile =
		// 0.995`). Post `plan-loudness-target-percentile-limit`: iteration
		// is 1D on `B`, limit constant across attempts.
		//
		// Fixture: `makeSynthetic` (sourceLufs ≈ -24.9, sourcePeak ≈
		// -17.8, sourceLra ≈ 0). Pass-1 produces several short-term
		// blocks all above the BS.1770 absolute gate (-70 LUFS), so
		// `pivotAutoDb` lands at a finite value (around -24.9 dBFS).
		//
		// Two behavior assertions:
		//   (a) output LUFS within tolerance of target (LUFS axis hit);
		//   (b) `winningLimitDb` lands within (pivotDb, sourcePeakDb] —
		//       the percentile is on a healthy distribution so the
		//       walk lands a few dB below source peak, not at the
		//       `+Infinity` sentinel.
		const input = makeSynthetic(TEST_FRAMES, TEST_SAMPLE_RATE, 1);
		const sourceLufs = measureLufs([input], TEST_SAMPLE_RATE);
		// Schema constrains `targetLufs` to `multipleOf(0.1)` — round
		// the source-relative target into a 0.1 dB grid so the factory
		// accepts it. The exact value isn't load-bearing; what matters
		// is that the lift is small enough to converge cleanly under
		// the auto-pivot wide-zone slope.
		const targetLufs = Math.round((sourceLufs + 0.5) * 10) / 10;

		const node = loudnessTarget({ targetLufs });

		expect(node).toBeDefined();

		const output = await runStream([input], TEST_SAMPLE_RATE, {
			targetLufs,
		});
		const outputChannel = output.channels[0];

		expect(outputChannel).toBeDefined();
		expect(outputChannel?.length).toBe(input.length);

		const lufs = measureLufs([outputChannel ?? new Float32Array(0)], TEST_SAMPLE_RATE);

		const sourcePeakDb = measureTruePeak([input], TEST_SAMPLE_RATE);

		console.log(`[test:auto-pivot] outputLufs=${lufs.toFixed(3)} target=${targetLufs.toFixed(3)} winningLimitDb=${output.winningLimitDb?.toFixed(4) ?? "?"} sourcePeakDb=${sourcePeakDb.toFixed(4)}`);

		// Re-baseline note (2026-05-11, plan-loudness-target-percentile-
		// limit Phase 4.2): tightened LUFS bound from 0.6 to keep the
		// 0.5 iteration tolerance + 0.1 residual headroom envelope.
		expect(Math.abs(lufs - targetLufs)).toBeLessThan(0.6);
		// `winningLimitDb` is the percentile-derived limit. On this
		// steady-amplitude fixture the top 0.5% of detection samples
		// sit just below source peak; assertion is the limit lands at
		// or below source peak (strict equality fails because the
		// percentile picks a bucket below the peak). A loose lower
		// bound 6 dB below source peak guards against runaway low.
		const limitDb = output.winningLimitDb;

		expect(limitDb).not.toBeNull();
		if (limitDb === null) return;
		expect(limitDb).toBeLessThanOrEqual(sourcePeakDb);
		expect(limitDb).toBeGreaterThan(sourcePeakDb - 6);
	});

	it("respects targetTp ceiling and proves the upper segment did the structural cap", async () => {
		// The original test 2 (synthetic broadband fixture, targetLufs=-16,
		// targetTp=-1) collapses to single-segment behaviour: B converges
		// to a value where `sourcePeak + B` already lands well below
		// targetTp, so the upper segment's TP cap is a no-op. The
		// reviewer's Issue 3 ask: pick a fixture and target combination
		// where `sourcePeak + B` would EXCEED targetTp, forcing the
		// upper segment's `peakGainDb` to do the structural attenuation.
		//
		// Setup uses the ramp fixture (sourcePeak ≈ -5.54 dBTP,
		// sourceLufs ≈ -14). targetLufs=-8 → B converges to ~+6 dB
		// lift. Without the upper segment, peaks would land at
		// sourcePeak + B = -5.54 + 6 ≈ +0.46 dBTP (clipping). With the
		// upper segment, peakGainDb = targetTp - sourcePeak = -2 -
		// (-5.54) = +3.54 dB lift at peak (vs +6 dB at body), so the
		// upper segment subtracts ~2.5 dB at the peak anchor and the
		// curve caps output peak at targetTp.
		const input = makeRamp(TEST_FRAMES_LRA, TEST_SAMPLE_RATE, 0.001, 0.5, 7);
		const sourcePeakDb = measureTruePeak([input], TEST_SAMPLE_RATE);
		const targetTp = -2;
		const output = await runStream([input], TEST_SAMPLE_RATE, {
			targetLufs: -8,
			pivot: -30,
			targetTp,
			smoothing: 1,
		});
		const outputChannel = output.channels[0];

		expect(outputChannel).toBeDefined();
		expect(outputChannel?.length).toBe(input.length);

		const truePeakDb = measureTruePeak([outputChannel ?? new Float32Array(0)], TEST_SAMPLE_RATE);
		const bestB = output.winningB ?? 0;
		const peakWithBOnly = sourcePeakDb + bestB;

		console.log(`[test:TP-ceiling] outputTruePeakDb=${truePeakDb.toFixed(3)} target=${targetTp} sourcePeakDb=${sourcePeakDb.toFixed(3)} bestB=${bestB.toFixed(3)} peakWithBOnly=${peakWithBOnly.toFixed(3)}`);

		// (a) Output true peak respects the cap (small smoothing-induced
		//     overshoot allowance).
		// Phase 4 (2026-05-10): with iteration also running at 4× rate,
		// the structural TP-overshoot fix lands. Live observation on
		// this fixture: outputTruePeakDb ≈ targetTp + 0.03 dB (down from
		// the pre-Phase-4 ~0.7–0.9 dB overshoot the plan targets in
		// Phase 6). The Phase-1 widening (+0.7 dB) tightens back to
		// +0.5 dB. Phase 6 adds a dedicated regression test that
		// asserts overshoot < 0.15 dB on a TP-rich synthetic fixture
		// (tightened from 0.3 by plan-loudness-target-tp-iteration);
		// this test continues to guard the looser +0.5 dB envelope on
		// the existing ramp-fixture path.
		expect(truePeakDb).toBeLessThan(targetTp + 0.5);

		// (b) Without the upper segment's `peakGainDb` cap, peaks would
		//     have exceeded targetTp by a meaningful margin. This guards
		//     against the test silently regressing back into single-
		//     segment territory where the upper segment is a no-op.
		//
		// Phase 4 (`plan-loudness-target-limit-axis`): the threshold
		// loosens from `targetTp + 0.5` to `targetTp`. The new geometry
		// adjusts `peakGainDb` proportionally so peaks always land at
		// targetTp regardless of B; consequently the iterator finds a
		// SMALLER B than the old spread-based geometry for the same
		// target LUFS (the body lift no longer needs to compensate for
		// upper-segment tension robbing energy). The "structural cap
		// did work" condition is still meaningful — `sourcePeakDb + B`
		// must exceed `targetTp` so the cap is non-trivial — but the
		// `+0.5` headroom margin reflected the prior geometry's
		// over-correction and no longer applies. The cross-test "TP-
		// overshoot regression" (in the heavy file) guards the tighter
		// `peakTolerance + 0.05 dB` upper bound on output TP.
		expect(peakWithBOnly).toBeGreaterThan(targetTp);
	});

	it("explicit limitDb override fixes the limit anchor (constant across attempts)", async () => {
		// Post `plan-loudness-target-percentile-limit`: the limit axis
		// no longer iterates. The user-facing knob is `limitDb` (explicit
		// override) or `limitPercentile` (statistical default).
		//
		// This test exercises the explicit-override path: pass `limitDb`
		// directly; assert `winningLimitDb` equals the override (within
		// the iterator's clamp). Replaces the prior "manual-config:
		// explicit pivot + targetLra engages the limitDb axis (2D
		// path)" test — the 2D path is gone; the limit is now a fixed
		// override-/percentile-derived value with a brick-wall above it.
		//
		// Fixture: ramp 0.001 → 0.5 (sourceLufs ≈ -14, sourcePeak ≈
		// -5.5 dBTP). Geometry chosen so the upper segment is wide
		// enough that the override sits well inside the feasible
		// window, but the LUFS axis is not assertion-bound — the
		// structural claim is "the user-supplied `limitDb` is what the
		// iterator used", not "this particular `(pivot, limitDb,
		// targetLufs)` combination converges". The narrower body
		// segment (pivot above source peak) and small lift target
		// keep the LUFS axis well-conditioned, but no LUFS bound is
		// asserted — exercising the explicit-override path is what's
		// load-bearing.
		const input = makeRamp(TEST_FRAMES_LRA, TEST_SAMPLE_RATE, 0.001, 0.5, 11);
		const sourcePeakDb = measureTruePeak([input], TEST_SAMPLE_RATE);

		// Place the override 1 dB below source peak so it sits in the
		// feasible window and the override is the load-bearing value
		// (rather than the iterator's clamp).
		const limitDb = Math.round((sourcePeakDb - 1) * 10) / 10;
		const result = await runStream([input], TEST_SAMPLE_RATE, {
			targetLufs: -12,
			pivot: -10,
			limitDb,
			smoothing: 1,
		});
		const outputChannel = result.channels[0];

		expect(outputChannel).toBeDefined();
		expect(outputChannel?.length).toBe(input.length);

		console.log(`[test:explicit-limit] winningLimitDb=${result.winningLimitDb?.toFixed(4) ?? "?"} limitDbOverride=${limitDb} sourcePeakDb=${sourcePeakDb.toFixed(3)}`);

		// `winningLimitDb` equals the override (within float tolerance —
		// the iterator's internal `clampLimit` is a no-op for values in
		// the feasible window).
		expect(result.winningLimitDb).not.toBeNull();
		expect(result.winningLimitDb ?? 0).toBeCloseTo(limitDb, 6);
	});

	it("converges with no floor (uniform B below pivot)", async () => {
		const input = makeSynthetic(TEST_FRAMES, TEST_SAMPLE_RATE, 23);
		// Same anchor concession as test 1 — pivot above source peak so
		// the no-floor branch (uniform B below pivot) actually drives
		// LUFS via B alone. With pivot below source peak the upper
		// segment dominates and the LUFS test stalls.
		const output = await runStream([input], TEST_SAMPLE_RATE, {
			targetLufs: -16,
			pivot: -15,
			smoothing: 1,
		});
		const outputChannel = output.channels[0];

		expect(outputChannel).toBeDefined();
		expect(outputChannel?.length).toBe(input.length);

		const lufs = measureLufs([outputChannel ?? new Float32Array(0)], TEST_SAMPLE_RATE);

		console.log(`[test:no-floor] outputLufs=${lufs.toFixed(3)} target=-16`);

		// `plan-loudness-target-deterministic` 2026-05-13 revert: the
		// 2D `iterateForTargets` loop is restored (analytical solver +
		// bounded secant correction were both reverted; the histogram
		// predictor is now a seed for iteration's initial `B`, not the
		// final answer). Iteration's secant + proportional feedback
		// drive `(B, peakGainDb)` to within the bag's
		// `0.5 iteration tolerance + 0.1 residual headroom envelope`.
		expect(Math.abs(lufs - (-16))).toBeLessThan(0.6);
	});
});
