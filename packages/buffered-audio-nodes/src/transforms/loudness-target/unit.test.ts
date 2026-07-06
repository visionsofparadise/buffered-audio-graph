/* eslint-disable no-console -- the node logs an iteration summary by design; tests run with vitest, console output is fine in CI. */
import { describe, expect, it } from "vitest";
import { LoudnessAccumulator, TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";
import { type Block, BlockBuffer } from "@buffered-audio/core";
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
	const stream = new LoudnessTargetStream({
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
		bufferSize: Infinity,
		overlap: 0,
	});
	const transformStream = stream.createTransformStream();
	const writer = transformStream.writable.getWriter();
	const reader = transformStream.readable.getReader();

	const drain = (async () => {
		const collected: Array<Array<Float32Array>> = [];

		while (true) {
			const next = await reader.read();

			if (next.done) return collected;

			collected.push(next.value.samples);
		}
	})();

	const samples: Array<Float32Array> = [];

	for (const channel of channels) samples.push(channel);

	const chunk: Block = { samples, offset: 0, sampleRate, bitDepth: 32 };

	await writer.write(chunk);
	await writer.close();

	const collected = await drain;

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
	const TEST_TIMEOUT_MS = 120_000;

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
	}, TEST_TIMEOUT_MS);

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
		// overshoot regression" (also in this file) guards the tighter
		// `peakTolerance + 0.05 dB` upper bound on output TP.
		expect(peakWithBOnly).toBeGreaterThan(targetTp);
	}, TEST_TIMEOUT_MS);

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
	}, TEST_TIMEOUT_MS);

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
	}, TEST_TIMEOUT_MS);
});

/**
 * Phase 6 (2026-05-10) — TP-overshoot regression test.
 *
 * Locks in the structural TP-overshoot fix delivered by Phase 4's 4×
 * upsampled detection / max-pool / curve / IIR / apply pipeline AND the
 * Phase-3 iterator (plan-loudness-target-tp-iteration, 2026-05-10) that
 * clamps residual post-IIR peak overshoot via per-attempt `peakGainDb`
 * adjustment (proportional feedback against `peakTolerance`).
 * Pre-refactor (Phase 1 baseline), `loudnessTarget` overshot
 * `targetTp = -1` by ~0.7–0.9 dB on TP-rich material — two effects
 * compounding: native-rate per-sample curve evaluation against a
 * 4× true-peak anchor (Effect 1, ~0.1–0.2 dB), and bidirectional IIR
 * averaging across the peak boundary pulling peak gain upward toward
 * upper-segment neighbours (Effect 2, ~0.7–0.9 dB, dominant). Phase 4
 * runs detection / max-pool / curve / IIR all at 4× rate, matching the
 * apply pass; the iteration-vs-output AA bias collapses, and the IIR's
 * smoothing pole-frequency matches the upsampled signal's bandwidth.
 * The 2026-05-10 iteration plan layered on top: with the iterator now
 * adjusting `peakGainDb` downward on observed overshoot until peak
 * lands within `peakTolerance` (default 0.1 dB) of `targetTp`, any
 * residual cross-boundary IIR pull-up is corrected by feedback rather
 * than carried into the output. Live observation on the existing ramp-
 * fixture test ("respects targetTp ceiling…") at end of Phase 4:
 * outputTruePeakDb ≈ targetTp + 0.026 dB. This test asserts a tighter
 * +0.15 dB bound (= peakTolerance 0.10 + 0.05 dB measurement / damping
 * slack) on a fixture explicitly engineered for inter-sample-peak
 * content.
 *
 * Fixture: 30 s mono at 48 kHz combining (a) a broadband body
 * signal — 220 Hz sine + LCG-seeded white noise, slow amplitude
 * ramp (0.001 → 0.5) over the full duration — with (b) a TP-rich
 * overlay of (4 kHz sine at -18 dBFS) + (12 kHz sine at -24 dBFS),
 * full-amplitude (not ramp-modulated) across the whole signal. The
 * plan §6.1 specifies a pure two-tone (4 kHz at -3 dBFS + 12 kHz
 * at -6 dBFS) fixture; this is a deviation from the spec recorded
 * inline on plan action 6.1. **Why the deviation**: the unmodulated
 * pure-tone fixture has no dynamic range (sourceLra ≈ 0, sourceLufs
 * ≈ source peak ≈ -1 dBFS), which causes `pivot` auto-derivation
 * to land essentially at the source peak (pivotDb ≈ peakDb − 0.4)
 * and the body-lift iteration cannot converge to any non-trivial
 * `targetLufs` (the per-tone energy is concentrated near peak, so
 * lift / cut cannot pull integrated LUFS far from source). The
 * closest-attempt fallback then runs the curve with a tiny upper-
 * segment width and a steep B-to-peakGainDb jump, where smoothing-
 * induced ripple produces ~0.4 dB TP overshoot for reasons
 * unrelated to Effect-1 / Effect-2 (the structural issues Phase 4
 * fixed). The body-plus-overlay form gives the source measurable
 * LRA (~6.5 LU), pulls auto-derived pivot well below source peak
 * (gain-riding zone width ~13 dB), lets the iteration produce a
 * meaningful operating point, and preserves the cross-frequency
 * inter-sample-peak content the regression is meant to lock in.
 * On the post-Phase-4 path this fixture observes ~0.04 dB
 * overshoot — comfortably under the 0.15 dB bound (tightened from
 * 0.3 dB by plan-loudness-target-tp-iteration). The
 * 4 kHz / 12 kHz overlay amplitudes (-18 / -24 dBFS) keep the
 * TP-rich content audibly subordinate to body so source LUFS is
 * driven by body and the overlay still contributes the
 * inter-sample peaks the 4× pipeline must handle.
 *
 * Methodology: configure `loudnessTarget({ targetLufs: -16, targetTp:
 * -1, smoothing: 1 })`, no `pivot` (auto-derive). Measure output true
 * peak via `TruePeakAccumulator` (4× upsampled, BS.1770-4 style) and
 * assert `outputTruePeakDb <= targetTp + 0.15`. The 0.15 dB threshold
 * is `peakTolerance` (0.10 dB default) plus 0.05 dB measurement /
 * damping slack — tightened from the predecessor plan's +0.3 dB
 * bound by plan-loudness-target-tp-iteration, which extended the
 * iterator with proportional-feedback control on `peakGainDb`. If
 * this test passes pre-refactor (i.e. the fixture isn't TP-rich
 * enough to discriminate), the assertion isn't actually guarding
 * the fix — escalation lever per plan §6.1's pitfall note.
 */

/**
 * Synthesise a TP-rich mono test signal: 4 kHz sine at -3 dBFS plus
 * 12 kHz sine at -6 dBFS. The two-frequency sum produces inter-sample
 * peaks above the per-sample max — both frequencies are well above the
 * Nyquist frequency of a downsample-by-4 grid relative to the 4×
 * upsampled domain, so reconstructed signal between sample grid points
 * crests above any single grid point. This is the regime where a
 * native-rate curve evaluator hands out body-lift gain to a sample
 * that, in the true-peak (upsampled) domain, sits near the peak anchor
 * — producing TP overshoot.
 */
function makeIntersamplePeakFixture(frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);
	// The fixture combines broadband body content (makes the iteration
	// converge cleanly) with cross-frequency near-Nyquist tones that
	// produce inter-sample peaks above the per-sample max. Body: 220 Hz
	// sine + LCG-seeded white noise (the same body signal `makeRamp`
	// uses elsewhere in this file). TP-rich overlay: 4 kHz + 12 kHz
	// sines at low amplitude (-18 / -24 dBFS) — high enough to create
	// inter-sample-peak content but low enough that they don't
	// dominate the body LUFS / LRA. Slow amplitude ramp (0.001 → 0.5)
	// over the duration gives the source measurable LRA so the
	// auto-pivot lands well below source peak and the iteration's
	// gain-riding zone is wide.
	let state = 7 >>> 0;
	const tpAmpA = Math.pow(10, -18 / 20); // -18 dBFS — TP-rich overlay
	const tpAmpB = Math.pow(10, -24 / 20); // -24 dBFS — TP-rich overlay
	const lowAmp = 0.001;
	const highAmp = 0.5;

	for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
		state = (state * 1664525 + 1013904223) >>> 0;

		const noise = (state / 0xffffffff - 0.5) * 0.05;
		const body = Math.sin((2 * Math.PI * 220 * frameIndex) / sampleRate);
		const tone4kHz = Math.sin((2 * Math.PI * 4_000 * frameIndex) / sampleRate) * tpAmpA;
		const tone12kHz = Math.sin((2 * Math.PI * 12_000 * frameIndex) / sampleRate) * tpAmpB;
		const rampFraction = frameIndex / frames;
		const ramp = lowAmp + (highAmp - lowAmp) * rampFraction;

		// Body (broadband, ramped) carries the LUFS / LRA dynamics;
		// the TP overlay rides on top to create inter-sample-peak
		// content the 4× pipeline must handle.
		out[frameIndex] = ramp * (body + noise) + (tone4kHz + tone12kHz);
	}

	return out;
}

describe("LoudnessTarget TP-overshoot regression", () => {
	const TP_TEST_TIMEOUT_MS = 180_000;

	it("output true peak respects targetTp within 0.15 dB on TP-rich content", async () => {
		// Pre-Phase-4 expected overshoot on this regime: ~0.7–0.9 dB
		// (the live-QA observation on the Pierce 60 s clip; the plan's
		// Problem section §1 documents the two effects). Post-Phase-4
		// expected overshoot: well under 0.15 dB (peakTolerance +
		// slack; tightened from the predecessor plan's +0.3 by
		// plan-loudness-target-tp-iteration). The existing ramp-
		// fixture test "respects targetTp ceiling…" measures +0.026 dB
		// on the post-Phase-4 path; this fixture is engineered to be
		// MORE TP-rich than the ramp (cross-frequency sum produces
		// stronger inter-sample peaks than a single-tone ramp); the
		// observed +0.044 dB sits comfortably under the 0.15 bound.
		const TP_TEST_FRAMES = TEST_SAMPLE_RATE * 30; // 30 s mono.
		const input = makeIntersamplePeakFixture(TP_TEST_FRAMES, TEST_SAMPLE_RATE);
		const sourcePeakDb = measureTruePeak([input], TEST_SAMPLE_RATE);
		const sourceLufs = measureLufs([input], TEST_SAMPLE_RATE);
		const targetTp = -1;
		// Plan §6.1 spec'd `targetLufs: -16` against an unmodulated
		// two-tone fixture; with the body-plus-overlay fixture
		// (deviation captured in the docstring above) sourceLufs lands
		// around -12.5 LUFS. Setting `targetLufs = sourceLufs - 4`
		// (rounded to the schema's `multipleOf(0.1)` grid) puts the
		// target inside the iteration's reach with a meaningful cut
		// (~4 LU) that exercises the upper-segment descending regime
		// where Effect-2 (IIR averaging across peak boundary) would
		// have produced the pre-Phase-4 overshoot. The absolute
		// `targetLufs` value isn't load-bearing — what matters is
		// (a) a non-trivial cut so the curve has descending upper
		// segment, and (b) `targetTp = -1` close enough to source peak
		// that the closed-form `peakGainDb` is non-zero.
		const targetLufs = Math.round((sourceLufs - 4) * 10) / 10;
		const output = await runStream([input], TEST_SAMPLE_RATE, {
			targetLufs,
			targetTp,
			smoothing: 1,
		});
		const outputChannel = output.channels[0];

		expect(outputChannel).toBeDefined();
		expect(outputChannel?.length).toBe(input.length);

		const outputTruePeakDb = measureTruePeak([outputChannel ?? new Float32Array(0)], TEST_SAMPLE_RATE);
		const overshoot = outputTruePeakDb - targetTp;

		console.log(
			`[test:tp-overshoot-regression] sourceLufs=${sourceLufs.toFixed(3)} ` +
				`targetLufs=${targetLufs.toFixed(3)} sourcePeakDb=${sourcePeakDb.toFixed(3)} ` +
				`outputTruePeakDb=${outputTruePeakDb.toFixed(3)} target=${targetTp} ` +
				`overshoot=${overshoot.toFixed(3)} dB (pre-Phase-4 expected ~0.7–0.9 dB)`,
		);

		// Structural assertion (Phase 5, plan-loudness-target-tp-iteration,
		// 2026-05-10): <= +0.15 dB overshoot (= peakTolerance default 0.10
		// + 0.05 dB measurement / damping slack). Tightened from the
		// predecessor plan's +0.3 dB bound now that the iterator clamps
		// post-IIR peak overshoot via per-attempt `peakGainDb` proportional
		// feedback. Observed at Phase 3 close on this fixture: +0.044 dB
		// (an order of magnitude under +0.15 dB). If this regresses past
		// +0.15 dB, escalate per the iteration plan's Phase 5 pitfall
		// note — either the AA balance has broken, a max-pool half-width
		// / IIR alpha mismatch at 4× rate has re-introduced Effect (2),
		// or the iterator's proportional-feedback damping is too
		// aggressive (try `PEAK_DAMPING = 0.5`).
		expect(outputTruePeakDb).toBeLessThanOrEqual(targetTp + 0.15);
	}, TP_TEST_TIMEOUT_MS);
});

/**
 * Phase 3 of `plan-loudness-target-stream-caching` (2026-05-12) —
 * process-RSS / heap-delta regression test.
 *
 * Locks in the further memory win delivered by migrating the
 * envelope and source caches to disk-backed `ChunkBuffer`s.
 * Pre-Phase-3, the iteration loop held:
 *   - `forwardScratch: Float32Array(frames × OVERSAMPLE_FACTOR)` —
 *     transient per-attempt, ~`frames × 16` bytes flat in RAM.
 *   - `bestSmoothedEnvelope: Float32Array(frames × OVERSAMPLE_FACTOR)` —
 *     held through `_unbuffer`, same size.
 *   - Plus a brief three-envelope overlap during the defensive-copy
 *     step on best-attempt update.
 * Post-Phase-3:
 *   - Three single-channel `ChunkBuffer`s during iteration
 *     (forward, active, winning) that each lazily spill above the
 *     10 MB scratch threshold. RAM footprint per buffer is bounded at
 *     ~10 MB regardless of source length; the rest spills to a temp
 *     file.
 *   - One `ChunkBuffer` for the winning envelope outlives
 *     iteration (~10 MB RAM ceiling) plus one for the upsampled-
 *     source cache (Phase 2.4; same ~10 MB RAM ceiling).
 *   - Per-chunk scratch in `applyBackwardPassOverChunkBuffer`
 *     (2 × `chunkSize × 4` bytes scratch), per-chunk apply
 *     scratch, and the source-channel buffer in the test's in-memory
 *     `ChunkBuffer` scratch (fixture stays under the 10 MB threshold).
 *
 * The assertion bound: peak `arrayBuffers` delta during `_process` <
 * ~ ~200 MB on a 1-minute mono fixture. The pre-Phase-3 bound was
 * `frames × 48 + 100 MB slack` = ~150 MB structural + 100 MB slack
 * for the test fixture; post-Phase-3 the structural component
 * collapses to ~50 MB (5 ChunkBuffers × ~10 MB RAM ceiling) +
 * per-chunk scratch + the source-channel in-memory scratch copy.
 * The 100 MB slack is preserved — V8 GC / JIT noise has not changed,
 * and the source-channel buffer (the in-memory `ChunkBuffer` scratch
 * retains the full fixture as `Float32Array` since the test bypasses
 * the spill threshold) is also untouched by Phase 3. Test job: detect
 * catastrophic regressions (a regression to flat `frames × 16` byte
 * arrays for envelopes lands +~46 MB on the test fixture, well
 * outside the tightened bound).
 *
 * Methodology:
 *   - Construct a synthetic 1-minute mono fixture (2 880 000 frames at
 *     48 kHz). Plan §"Test-runtime cost" allows scaling the spec'd
 *     5-minute fixture down when it dominates wall-clock. Per-trial
 *     `_process` runs ~80–100 s on this fixture in CI (10 attempts ×
 *     two source walks per attempt, all at 4× upsampling) so the
 *     trial count is held to 3 to keep total runtime under the
 *     `MEMORY_TEST_TIMEOUT_MS` budget. The memory bound scales
 *     linearly with `frames`, so a shorter fixture proves the bound
 *     just as cleanly — what's load-bearing is the bound's *form* (no
 *     source-sized non-transient state beyond the winning envelope),
 *     not the absolute byte count.
 *   - Drive `_process` directly via a `ChunkBuffer` — bypasses
 *     the `TransformStream` plumbing and scopes the measurement to the
 *     learn pass + the small `oversamplers`-array allocation that
 *     follows. `_unbuffer` is NOT exercised; the test's bound applies
 *     specifically to the `_process` boundary.
 *   - Wrap `_process` in a polling sampler (`setInterval` at 5 ms)
 *     that records `process.memoryUsage().arrayBuffers` throughout the
 *     call. **Why `arrayBuffers`, not `heapUsed`**: `Float32Array`
 *     data is stored OUTSIDE V8's JS heap, in C++-allocated
 *     `ArrayBuffer`s tracked by `process.memoryUsage().arrayBuffers`.
 *     An early implementation sampled `heapUsed` and showed deltas of
 *     0.1 MB on a fixture that allocates ~88 MB of winning envelope
 *     alone — `heapUsed` is the wrong dial. The actual source-sized
 *     arrays (winning envelope, transient `forwardScratch`, per-chunk
 *     upsampled scratch, source-channel buffer in `ChunkBuffer` scratch)
 *     all land in `arrayBuffers`. The plan's `frames * 32 + 50 MB
 *     slack` formula refers to the ArrayBuffer footprint regardless of
 *     which `process.memoryUsage` field reflects it.
 *   - Force GC before the baseline snapshot and after `_process` to
 *     amortise V8 allocator/GC noise.
 *   - Run 3 trials (fresh stream + buffer per trial) and assert against
 *     the median peak delta. Per the plan's "10% variance" stance, the
 *     bound is 50 MB above the structural target — generous enough that
 *     a 10–20% trial-to-trial variance won't false-positive.
 *   - When `global.gc` is unavailable, write a `process.stderr.write`
 *     warning and emit `expect.fail` so CI surfaces the gap. The
 *     vitest config in this package wires `--expose-gc` via the
 *     forks pool's `execArgv`, so in normal CI the failure path does
 *     not fire.
 */

const MEMORY_TEST_FRAMES_PER_TRIAL = TEST_SAMPLE_RATE * 60 * 1; // 1 minute mono — see methodology above.
const MEMORY_TEST_TRIALS = 3;
// Slack widened from 50 MB → 100 MB after independent reviewer reproduced
// trial-to-trial variance up to ~20 MB under full-suite parallel load (one
// trial at 182.4 MB on a 181.8 MB bound — median passed but margin was
// 3.1 MB, flake-prone). The bound's purpose is catastrophic-regression
// detection; 100 MB is still well below the `frames * 16` ≈ 88 MB cost of a
// regressed cached detection envelope on the test fixture, so detection
// power is unchanged.
const MEMORY_TEST_SLACK_BYTES = 100 * 1024 * 1024;
const HEAP_SAMPLE_INTERVAL_MS = 5;
const FLOAT32_BYTES = 4;
// Post the 2026-05-13 base-rate-downstream rewrite the winning
// envelope is sized at `frames` (base rate, no `× OVERSAMPLE_FACTOR`
// factor). The bound formula below absorbs this — the test no longer
// multiplies frames by an oversample factor.

/**
 * Force V8 to collect garbage before taking a heap snapshot. Calls
 * `global.gc()` twice with a microtask gap so any objects retained by
 * pending `Promise` resolutions are freed (V8's GC sometimes needs a
 * second pass to clear out the young generation reliably). Returns the
 * `arrayBuffers` byte count after the GC — this is where `Float32Array`
 * backing stores live, not on V8's JS heap (`heapUsed`). Caller must
 * check `global.gc` exists before calling — this helper assumes it
 * does.
 */
async function snapshotArrayBuffersAfterGc(): Promise<number> {
	const gc = (globalThis as { gc?: () => void }).gc;

	if (gc === undefined) {
		throw new Error("snapshotArrayBuffersAfterGc requires --expose-gc");
	}

	gc();
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
	gc();

	return process.memoryUsage().arrayBuffers;
}

/**
 * Drive `_process` against a freshly-allocated stream + buffer and
 * return:
 *   - `peakArrayBuffersBytes`: maximum `arrayBuffers` observed during
 *     the call, sampled by a `setInterval` at
 *     `HEAP_SAMPLE_INTERVAL_MS`.
 *   - `postProcessRetainedBytes`: `arrayBuffers` retained AFTER the
 *     call returns and AFTER `global.gc()` has run twice — i.e. the
 *     steady-state "winning envelope is held; everything else is
 *     released".
 *   - `winningEnvelopeLength`: the upsampled length of the winning
 *     envelope, asserting it lands at the expected `frames * 4` size.
 *
 * Each invocation allocates its own stream and buffer; nothing is
 * carried across trials. The caller is responsible for forcing GC
 * BEFORE the call to establish a clean baseline.
 */
async function runProcessAndMeasureArrayBuffers(frames: number, sampleRate: number, baselineBytes: number): Promise<{
	peakArrayBuffersBytes: number;
	postProcessRetainedBytes: number;
	winningEnvelopeLength: number;
}> {
	const samples = makeSynthetic(frames, sampleRate, 17);
	const buffer = new BlockBuffer();

	await buffer.write([samples], sampleRate, 32);
	await buffer.flushWrites();

	const stream = new LoudnessTargetStream({
		targetLufs: -20,
		smoothing: 1,
		tolerance: 0.5,
		peakTolerance: 0.1,
		maxAttempts: 10,
		bufferSize: Infinity,
		overlap: 0,
	});

	let peakBytes = baselineBytes;
	const samplePeak = (): void => {
		const current = process.memoryUsage().arrayBuffers;

		if (current > peakBytes) peakBytes = current;
	};
	const samplerHandle: ReturnType<typeof setInterval> = setInterval(samplePeak, HEAP_SAMPLE_INTERVAL_MS);

	try {
		// Drive the learn pass directly. `_process` is `protected` on
		// `BufferedTransformStream`, so the cast through `unknown` is
		// the only escape hatch — same pattern `runStream` uses to
		// reach `winningB` / `winningLimitDb` for diagnostic assertions.
		await (stream as unknown as { _process(buffer: BlockBuffer): Promise<void> })._process(buffer);
	} finally {
		clearInterval(samplerHandle);
	}

	// Read the winning envelope frame count BEFORE GC so we don't
	// accidentally drop the reference. The stream's reference holds it
	// alive. Post-Phase-3 the envelope is a `ChunkBuffer`, not a
	// flat `Float32Array` — we read its `frames` for the size sanity
	// check downstream.
	const diagnostics = stream as unknown as { winningSmoothedEnvelopeBuffer: { frames: number } | null };
	const winningEnvelopeBuffer = diagnostics.winningSmoothedEnvelopeBuffer;
	const winningEnvelopeLength = winningEnvelopeBuffer?.frames ?? 0;
	// Final sample after `_process` returns but before GC — this catches
	// the case where the helper completes between sampler ticks.
	samplePeak();

	// Hold a reference to the stream until after the GC + heap read so
	// the `winningSmoothedEnvelopeBuffer` is intentionally retained. The
	// transient envelope buffers (`forwardEnvelopeBuffer`, the losing
	// active buffer) are closed by `iterateForTargets` in its `finally`
	// and no longer reachable.
	const postProcessRetainedBytes = await snapshotArrayBuffersAfterGc();

	// Touch the stream's persistent state to keep the JIT from optimising
	// away the retention. The `void` discard is intentional.
	void winningEnvelopeBuffer?.frames;
	void stream;

	await (stream as unknown as { _teardown(): Promise<void> })._teardown();
	await buffer.close();

	return { peakArrayBuffersBytes: peakBytes, postProcessRetainedBytes, winningEnvelopeLength };
}

function median(values: ReadonlyArray<number>): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);

	if (sorted.length % 2 === 0) {
		return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
	}

	return sorted[middle] ?? 0;
}

describe("LoudnessTarget memory regression", () => {
	const MEMORY_TEST_TIMEOUT_MS = 600_000;

	it("peak heap during _process scales with chunk size + bounded scratch + winning envelope, not source size", async () => {
		const gc = (globalThis as { gc?: () => void }).gc;

		if (gc === undefined) {
			process.stderr.write(
				"[loudness-target memory test] global.gc unavailable — `--expose-gc` is not wired into the vitest worker. " +
					"Skipping the heap-delta assertion. The vitest config at packages/buffered-audio-nodes/vitest.config.ts " +
					"sets `pool: 'forks'` with `execArgv: ['--expose-gc']`; if this warning fires, that wiring has regressed.\n",
			);

			// Emit a soft assertion failure so CI surfaces the gap. Per
			// the plan: "DO NOT make the test silently pass when GC is
			// unavailable — the regression test must actually run." We
			// fail with a clear message rather than skip, so the
			// regression test is never inert in CI.
			expect.fail(
				"global.gc is unavailable — `--expose-gc` plumbing has regressed. The memory regression test cannot run without it. " +
					"Re-check packages/buffered-audio-nodes/vitest.config.ts.",
			);

			return;
		}

		const frames = MEMORY_TEST_FRAMES_PER_TRIAL;
		// Post `plan-loudness-target-deterministic` Phase 2: iteration
		// collapsed to a single solve + single apply pass. The buffer
		// model is now:
		//   1. `detectionEnvelope` cache at BASE rate (~10 MB ceiling
		//      but actually much smaller — 1 channel × frames base-
		//      rate samples × 4 bytes ≈ 11 MB on this fixture, just
		//      above the threshold and spilling). Closed immediately
		//      after the apply pass.
		//   2. `forwardEnv` at BASE rate (~10 MB ceiling) — transient
		//      Walk A output. Closed immediately after the backward
		//      pass.
		//   3. `minHeldEnv` at BASE rate (~10 MB ceiling) — transient
		//      brick-wall ceiling. Closed immediately after the
		//      backward pass.
		//   4. `winningSmoothedEnvelopeBuffer` (`smoothedEnv` while
		//      `_process` runs) at BASE rate (~10 MB ceiling) — the
		//      survivor. Closed in `_teardown`.
		// Plus a transient `iirForwardOrder` ChunkBuffer (~10 MB)
		// allocated INSIDE `applyBackwardPassOverChunkBuffer` for the
		// reverse-then-clamp path; coexists with detection / forward /
		// minHeld / smoothed for the duration of the clamp pass, then
		// closes before any of the persistent four. Peak coexistence
		// during the clamp pass: 5 base-rate ChunkBuffers.
		//
		// The prior 2D-iteration design (pre-Phase-2) carried a
		// double-buffered active/winning swap plus the `activeBufferA`
		// / `activeBufferB` lifecycle — 5 base-rate ChunkBuffers
		// permanently and 6 momentarily during the clamp pass. Phase 2
		// removes the swap mechanic; the solver runs ONE apply pass
		// against the solved anchors and never holds two
		// smoothed-envelope buffers concurrently.
		//
		// Plus per-chunk apply scratch (bounded by `CHUNK_FRAMES`),
		// per-chunk allocations inside `applyForwardPass` and
		// `applyBackwardPassOverChunkBuffer`, and the source-channel
		// `Float32Array` held by the test's in-memory `ChunkBuffer`
		// scratch (the 1-min fixture is just above the 10 MB threshold
		// and spills).
		const chunkBufferMemoryCeilingBytes = 10 * 1024 * 1024; // ~10 MB per ChunkBuffer in RAM
		const fileChunkBuffersDuringIteration = 5; // detection, forward, minHeld, smoothed, transient iirForwardOrder during clamp
		const sourceChannelBytes = frames * FLOAT32_BYTES; // in-memory ChunkBuffer scratch keeps the source flat
		// Per-chunk allocation churn during iteration. Each chunk
		// (~705 KB at the upsampled rate, ~176K samples × 4 bytes)
		// allocates: `Float32Array.from(input)` inside
		// `applyForwardPass`, `Float32Array` returns from
		// `Oversampler.downsample`, per-channel transformed scratch
		// (kept by `LoudnessAccumulator.push` + `TruePeakAccumulator.push`).
		// GC timing affects how many of these coexist during the
		// sampling interval. Empirically the peak fluctuates ~10-20 MB
		// trial-to-trial under full-suite parallel load. Budget ~80 MB
		// here to absorb that churn comfortably — far below the
		// pre-Phase-3 138 MB structural component (3 × frames × 16
		// bytes for forwardScratch / winning / defensive-copy).
		const perChunkChurnBytes = 50 * 1024 * 1024;
		const peakBoundBytes
			= fileChunkBuffersDuringIteration * chunkBufferMemoryCeilingBytes
			+ sourceChannelBytes
			+ perChunkChurnBytes
			+ MEMORY_TEST_SLACK_BYTES;
		// Sanity: the bound is substantially below the pre-Phase-3
		// `frames × 48 + 100 MB` ceiling. If a regression to flat
		// `Float32Array` envelopes lands, the resulting peak will
		// exceed this bound by ~46 MB (one envelope's worth of flat
		// frames × 16 bytes) and the assertion below catches it.
		const prePhase3Bound = frames * 48 + MEMORY_TEST_SLACK_BYTES;

		expect(peakBoundBytes).toBeLessThan(prePhase3Bound);

		// Retained bound: only the winning-envelope buffer survives
		// `_process` (closed in `_teardown`, not before) post the
		// 2026-05-13 base-rate-downstream rewrite — the upsampled-
		// source cache no longer exists. Plus the source-channel
		// in-memory ChunkBuffer copy and per-chunk scratch reclaimed
		// by GC. Slack absorbs GC residue / JIT artefacts.
		const retainedBoundBytes
			= 1 * chunkBufferMemoryCeilingBytes // winning envelope only (no upsampled-source post-rewrite)
			+ sourceChannelBytes
			+ MEMORY_TEST_SLACK_BYTES;

		const peakDeltas: Array<number> = [];
		const retainedDeltas: Array<number> = [];
		const winningLengths: Array<number> = [];

		for (let trialIdx = 0; trialIdx < MEMORY_TEST_TRIALS; trialIdx++) {
			const baselineBytes = await snapshotArrayBuffersAfterGc();
			const trial = await runProcessAndMeasureArrayBuffers(frames, TEST_SAMPLE_RATE, baselineBytes);
			const peakDelta = trial.peakArrayBuffersBytes - baselineBytes;
			const retainedDelta = trial.postProcessRetainedBytes - baselineBytes;

			peakDeltas.push(peakDelta);
			retainedDeltas.push(retainedDelta);
			winningLengths.push(trial.winningEnvelopeLength);

			console.log(
				`[loudness-target memory] trial=${trialIdx + 1}/${MEMORY_TEST_TRIALS} ` +
					`peakDeltaMB=${(peakDelta / (1024 * 1024)).toFixed(1)} ` +
					`retainedDeltaMB=${(retainedDelta / (1024 * 1024)).toFixed(1)} ` +
					`winningEnvelopeLen=${trial.winningEnvelopeLength}`,
			);
		}

		const medianPeak = median(peakDeltas);
		const medianRetained = median(retainedDeltas);

		console.log(
			`[loudness-target memory] medianPeakDeltaMB=${(medianPeak / (1024 * 1024)).toFixed(1)} ` +
				`boundMB=${(peakBoundBytes / (1024 * 1024)).toFixed(1)} ` +
				`medianRetainedDeltaMB=${(medianRetained / (1024 * 1024)).toFixed(1)} ` +
				`retainedBoundMB=${(retainedBoundBytes / (1024 * 1024)).toFixed(1)}`,
		);

		// Assertion 1 — peak-heap bound. Catches catastrophic
		// regressions such as accidental flat `frames × 16` byte
		// `Float32Array` envelopes (the pre-Phase-3 state) — that
		// would re-add ~46 MB to the bound on this fixture, which
		// already includes 100 MB slack. Post `plan-loudness-target-
		// deterministic` Phase 2 the structural component is ~5 ×
		// 10 MB = 50 MB of ChunkBuffer RAM (detection / forwardEnv /
		// minHeldEnv / smoothedEnv / transient iirForwardOrder during
		// the clamp pass) plus the source-channel in-memory ChunkBuffer
		// copy plus per-chunk scratch.
		expect(medianPeak).toBeLessThan(peakBoundBytes);

		// Assertion 2 — post-`_process` retained heap is bounded by
		// the persistent `winningSmoothedEnvelopeBuffer` RAM ceiling
		// (the only ChunkBuffer that survives `_process` post Phase 2
		// — detection / forward / minHeld are all closed before
		// `_process` returns) + the source-channel in-memory
		// `ChunkBuffer` copy + slack. The winning envelope is a
		// ~10 MB ChunkBuffer ceiling; the source channel is
		// `frames × 4` bytes flat. If a regression accidentally
		// retains a transient envelope as a flat `Float32Array`
		// (e.g. assigning `forwardScratch` to a stream-class field),
		// this assertion fires on the extra `frames × 16` bytes
		// failing to release.
		expect(medianRetained).toBeLessThan(retainedBoundBytes);

		// Assertion 3 — winning envelope is at the expected `frames
		// * 4` frames count (single-channel `ChunkBuffer.frames`
		// post-Phase-3). Sanity-checks that the iteration actually
		// produced an envelope — if a trial's pass-through bail
		// short-circuited (`winningSmoothedEnvelopeBuffer` is `null`
		// or zero-frames), the retained-heap bound would look
		// artificially tight and the test would lose its teeth.
		for (const length of winningLengths) {
			expect(length).toBe(frames);
		}
	}, MEMORY_TEST_TIMEOUT_MS);
});
