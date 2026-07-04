// Node-local per-window delta gate + binding-peak stratum for crestReduce
// (NOT shared DSP — node-specific composition glue; the 2026-04-23
// design-architecture boundary: reusable primitives live in
// buffered-audio-nodes-utils, node-specific composition stays node-local).
//
// Phase 3 (plan-crest-reduce-envelope-v2.md) builds the v2 per-window
// delta GATE — the structural precondition for the Phase-4 Item-7
// per-binding-peak search. The mechanism (design-crest-reduce.md v2
// Decision §"Per-window delta gate"; §Algorithm Specification Item 10
// the ≈identity-on-diffuse/already-limited prior art the gate realizes):
//
//   1. Measure the WHOLE-SIGNAL 4× true peak ONCE, streamed from a
//      sequential chunked walk over the disk-backed `ChunkBuffer` — NO
//      resident whole-signal array (the design-streaming.md
//      materialization anti-pattern Phase 2 removed must NOT creep back).
//      The 2026-05-17 keystone also threads the input-sample index of
//      that global 4× true peak (the `TruePeakArgmaxAccumulator` argmax,
//      accumulated per-chunk in `CrestReduceStream._buffer`).
//   2. Per analysis window, classify: a window is *binding* iff BOTH
//      (a) it has phase-only-recoverable crest headroom, measured by the
//      VERBATIM `peakPriorityAmount`, above BINDING_HEADROOM_MIN (the
//      headroom term — "acting here CAN move the file's true peak") AND
//      (b) the window's own per-channel 4× TRUE PEAK is within
//      BINDING_DELTA_DB of the global 4× true peak (the proximity term,
//      now in the SAME 4×-true-peak domain as the global number — the
//      2026-05-17 keystone correction; the old raw summed-sample
//      magnitude was a DIFFERENT domain and could skip the very frame
//      that determines the file's 4× true peak) OR the frame is the one
//      containing the file's global 4× true peak (force-bind — robust
//      to per-frame cold-history TP undercount). A binding window can
//      move the file's true peak (the Item-7 search acts there); a
//      non-binding window — its 4× true peak too far below the global,
//      OR with no crest headroom for a phase-only all-pass to flatten —
//      is EXACT identity (a no-op cannot raise a peak it does not
//      touch — this is what makes the localized never-worsen preserve
//      the whole-signal guarantee).
//
// WHY the headroom term (the directed Option-1 resolution; recorded as
// the 3.1/3.2 Deviation in plan-crest-reduce-envelope-v2.md). The v2
// Decision §"Per-window delta gate" grounds the gate in *windowed
// PEAK-PRIORITISED targeting* and states its purpose: "Peaks below the
// binding stratum cannot move the file's true peak." A phase-only
// all-pass CANNOT reduce an already-limited / zero-crest-headroom
// window's true peak (§Algorithm Specification Item 10's core finding;
// the as-built Phase-6 result was exactly 0.000 dB on pre-clipped —
// "the prior-art-predicted content-gated outcome, not a defect"). So a
// near-global-TP window with no crest headroom is, in the design's own
// terms, NOT a window where acting can move the file's true peak ⇒ it
// MUST be non-binding. The proximity term alone was a PROXY for "can
// acting here move the global true peak"; the headroom term corrects
// that proxy to the design's stated intent. This is REQUIRED by this
// plan's own 3.2 Verify + Pre-Execution Review Risk 2/O3: with the
// literal proximity-only formula a genuinely zero-crest-headroom fixture
// (`makePreClipped`, `peakPriorityAmount` = 0.0000) whose hard-clip
// inter-sample overshoot puts the 4× true peak NEAR every window's
// sample peak would be flagged binding, making the 3.2 pre-clipped
// bit-identity / Item-10 identity-on-already-limited assertion
// UNSATISFIABLE. The headroom term refines (does not contradict) the
// Phase-4 binding set: it is strictly MORE conservative (more windows
// exact-identity), and Phase 4's Item-7 `c₀=0`/skip-if-already-met +
// commit-only-if-better would collapse zero-headroom windows to identity
// anyway. It does NOT change the v2 approach or re-decide the
// design/keystone. The formal design-doc §gate-bullet wording
// reconciliation is left to Phase 7's design write-back (Phase 3 is not
// the design-write-back phase — see the plan's `### Phase 7` note).
//
// The gate's window-targeting lineage is PROJECT GLUE (the Phase-1 1.2
// contract row 1): windowed peak-prioritised targeting, the
// `loudnessTarget` windowed-max gain-envelope precedent — no external
// grounding required or claimed. The BINDING_DELTA_DB band AND the
// BINDING_HEADROOM_MIN threshold are both the project's own QA-tuned
// calibration (Phase-6 calibration inputs — see their JSDocs), NOT
// sourced, NOT exposed in the schema.

import type { ChunkBuffer } from "@buffered-audio/core";
import { peakPriorityAmount } from "./lattice";
import { measureFrameTruePeakDb } from "./objective";
import { measureBufferTruePeakDb } from "./windowed";

/**
 * **The per-window binding delta (dB) — PROJECT GLUE, QA-tuned, NOT
 * sourced, NOT exposed.**
 *
 * An analysis window is *binding* (the Item-7 search acts on it) iff its
 * own per-channel **4× true peak** is within this many dB of the
 * whole-signal **4× true peak** (the 2026-05-17 keystone correction —
 * SAME true-peak domain on both sides; the old raw summed-sample
 * magnitude was a different domain and could skip the very frame that
 * determines the file's 4× true peak) OR the frame is the global-4×-TP
 * frame (force-bind); otherwise the window is EXACT identity (its 4×
 * true peak is too far below the file's true peak to ever move it, so
 * acting there cannot help and could only risk worsening —
 * design-crest-reduce.md v2 Decision §"Per-window delta gate": "Peaks
 * below the binding stratum cannot move the file's true peak").
 *
 * This is the project's OWN declared default — it is **not** an
 * Algorithm-Specification Item, has **no** external grounding, and is
 * **not** sourced (the Phase-1 1.2 contract glue piece ①; the v2
 * Decision §"Internal calibration" explicitly classes the binding-delta
 * band as not-exposed, QA-tuned). It is declared here as a SINGLE
 * internal constant precisely so **Phase 6 can re-tune it without
 * re-architecting** the gate (a Phase-6 calibration input). It is
 * deliberately NOT a schema field (the v2 user surface is `strength` +
 * `frameSize` + the FFT-addon paths only — the planner honesty rule: the
 * control surface must not expose an internal QA knob).
 *
 * 3 dB ≈ a factor of √2 in linear amplitude: a window whose peak is
 * within ~half the headroom of the global true peak is treated as one
 * that can move it. This is a conservative default (it errs toward
 * acting — a wider band binds more windows; a narrower band confines the
 * action further). Phase 6 calibrates the exact value against the
 * episode-060 real-source QA gate.
 */
export const BINDING_DELTA_DB = 3;

/**
 * **The minimum phase-only-recoverable crest headroom for a window to
 * bind — PROJECT GLUE, QA-tuned, NOT sourced, NOT exposed.**
 *
 * An analysis window binds (the Phase-4 search acts on it) only if its
 * VERBATIM {@link peakPriorityAmount} (the existing windowed crest →
 * smooth-saturating-headroom map, `utils/lattice.ts` `:201`, reused
 * UNMODIFIED — it is composed here, never re-implemented) exceeds this
 * threshold, AND the proximity term ({@link BINDING_DELTA_DB}) also
 * holds. `peakPriorityAmount` ≈ 0 on already-diffuse / already-limited /
 * zero-crest-headroom material (its own JSDoc: "low ratio (already-
 * diffuse / already-limited) = no headroom, map toward 0 (≈identity) …
 * the `loudnessTarget`-windowed-max-envelope analogue") and → 1 on
 * strongly-peaky content with genuine phase-only recoverable headroom.
 * Below this threshold a phase-only all-pass cannot move the window's
 * true peak (§Algorithm Specification Item 10), so the window MUST be
 * EXACT identity even if its raw sample peak sits near the global true
 * peak (the directed Option-1 resolution — see this module's header).
 *
 * Like {@link BINDING_DELTA_DB} this is the project's OWN declared
 * default — **not** an Algorithm-Specification Item, **no** external
 * grounding, **not** sourced (the v2 Decision §"Internal calibration"
 * classes the gate's calibration as not-exposed, QA-tuned). It is a
 * SINGLE internal constant precisely so **Phase 6 can re-tune it without
 * re-architecting** the gate (a Phase-6 calibration input), and it is
 * deliberately NOT a schema field (the v2 user surface is `strength` +
 * `frameSize` + the FFT-addon paths only).
 *
 * **Phase-3 default was 0.05; Phase-6-CALIBRATED to 0.5 (the
 * QA-tuned value).** Phase 3 shipped a deliberately-low 0.05 (the
 * load-bearing constraint there was only zero-headroom → bit-identical;
 * the exact value was explicitly deferred to Phase 6 — "raise the
 * threshold toward ≈0.3–0.5 against the episode-060 real-source QA
 * gate"). Phase 6's empirical episode-060 real-source one-factor sweep
 * (`scratch/qa-crest-reduce-v2.ts`/`.out`; strength 1, frameSize 2048,
 * BINDING_DELTA_DB 3, LOCAL_TRANSITION_MS 1.0) measured, on the v2
 * Decision's load-bearing un-mastered source:
 *   - hdrmin 0.05: ΔTP +0.950 dB, ERB-LSD 0.124, bind 6.6% of frames
 *   - hdrmin 0.20: ΔTP +1.348 dB, ERB-LSD 0.112, bind 5.3%
 *   - hdrmin 0.35: ΔTP +1.348 dB, ERB-LSD 0.085, bind 3.7%
 *   - hdrmin 0.50: ΔTP +1.348 dB, ERB-LSD **0.062**, bind **2.3%**
 * — a clean, monotone calibration win: raising hdrmin from 0.05 toward
 * 0.5 INCREASES the real-source true-peak reduction (+0.950 → +1.348 dB,
 * then plateaus) while monotonically REDUCING coloration (ERB-LSD
 * 0.124 → 0.062) and confining the gate (6.6% → 2.3% of frames). 0.5 is
 * the transparency knee on the real target content. It is the project's
 * OWN QA-tuned choice (NOT sourced — the v2 Decision §"Internal
 * calibration" classes the gate calibration as not-exposed, QA-tuned).
 * Phase-6 faithfulness-verified: the Phase-5 invariant suite's
 * `makeHeadroomBearing` mandatory-efficacy fixture has
 * `peakPriorityAmount` ≈ 1.0 (Phase-3 measured) ⇒ `1.0 > 0.5` still
 * binds, so the Phase-5 (i) hard `ΔTP ≥ 1.0 dB` spec is UNCHANGED at
 * 0.5 (measured: identical +3.3794 dB at the unit-test fixture/seed) —
 * the retune is a strict real-source improvement at zero cost to the
 * synthetic efficacy guard. The genuinely-zero-headroom Risk-2/O3
 * guarantee is strengthened, not weakened (`0.0000 > 0.5` is still
 * decisively false ⇒ zero-headroom content stays robustly non-binding /
 * bit-identical). `makeDense` (`peakPriorityAmount` ≈ 0.31–0.40) is now
 * correctly NON-binding at 0.5 (the principled ≈identity outcome for
 * already-diffuse content — Item 10; previously bound-with-tiny-effect
 * at 0.05). The Phase-5 suite stays green at 0.5 (re-verified — see
 * plan-crest-reduce-envelope-v2.md `### 6.3`).
 */
export const BINDING_HEADROOM_MIN = 0.5;

/**
 * The binding classification of one analysis window plus the in-window
 * peak metadata the Phase-4 Item-7 search consumes (its search target:
 * `φ(c) = |p(n_i)|² − η` is evaluated AT the peak sample `n_i`, Item 7 /
 * Phase-1 1.2 contract row 2).
 */
export interface WindowBinding {
	/**
	 * `true` iff the window's {@link peakPriorityAmount} exceeds
	 * {@link BINDING_HEADROOM_MIN} (phase-only-recoverable crest headroom)
	 * AND ( the window's own per-channel **4× true peak**
	 * ({@link frameTruePeakDb}) is within {@link BINDING_DELTA_DB} of the
	 * whole-signal 4× true peak — SAME true-peak domain, the 2026-05-17
	 * keystone correction — OR the frame is the global-4×-TP frame
	 * (force-bind) ) — the Item-7 search acts on it. `false` ⇒ the window
	 * is **exact identity** (a no-op cannot raise a peak it does not
	 * touch — load-bearing for the whole-signal never-worsen guarantee).
	 */
	readonly binding: boolean;
	/**
	 * Index (within the window, `0 ≤ peakIndex < windowLength`) of the
	 * channel-SUM sample with the largest |value| — the per-peak-exact
	 * hold's `n_i` and the Item-7 φ′ proposal's raw-sample argmax. `-1`
	 * for an empty window.
	 */
	readonly peakIndex: number;
	/**
	 * The signed channel-SUM sample value at {@link peakIndex}. `0` for an
	 * empty window.
	 */
	readonly peakValue: number;
	/** The channel-SUM window's max |peak| (linear). `0` for empty. */
	readonly peakMagnitude: number;
	/**
	 * The window's phase-only-recoverable crest headroom — the VERBATIM
	 * {@link peakPriorityAmount} of the channel-sum window (∈ [0,1]; ≈0 =
	 * already-diffuse / already-limited / no headroom, →1 = strongly peaky
	 * with genuine recoverable headroom). The window binds only if this
	 * exceeds {@link BINDING_HEADROOM_MIN} (in addition to the proximity
	 * OR force-bind term). `0` for an empty window.
	 */
	readonly headroom: number;
	/**
	 * The window's own per-channel **4× true peak** (dBTP) —
	 * {@link measureFrameTruePeakDb} of the per-channel windows (a FRESH
	 * cold accumulator per call, by that function's contract). This is
	 * the proximity LHS, now in the SAME 4×-true-peak domain as the
	 * global number (the 2026-05-17 keystone correction). The
	 * `linearToDb` silence floor (−200 dB) for an empty / silent window.
	 */
	readonly frameTruePeakDb: number;
}

/**
 * Whole-signal 4× true peak (dBTP) of the disk-backed `ChunkBuffer`,
 * streamed from a sequential chunked walk — the gate's single global
 * measurement.
 *
 * Composes the VERBATIM Phase-2 streaming-measure precedent
 * {@link measureBufferTruePeakDb} (a single fresh `TruePeakArgmaxAccumulator`
 * driven over `read(n)`/`reset()` chunked reads — its per-channel
 * polyphase upsampler carries a 12-tap input history across `push`, so
 * chunk boundaries are invisible and this is FP-identical to a
 * fresh-accumulator measurement of the same contiguous samples; the
 * `utils/objective.ts` `measureFrameTruePeakDb` fresh-accumulator
 * discipline, applied streaming). This deliberately does NOT re-implement
 * the streaming walk — there is exactly ONE streaming-measure
 * implementation in the node (the Phase-2 module), reused here so the
 * gate's global TP and the never-worsen's input TP are the identical
 * measurement. NO resident whole-signal array is ever materialized (the
 * design-streaming.md anti-pattern stays removed).
 */
export async function measureWholeSignalTruePeakDb(buffer: ChunkBuffer, sampleRate: number): Promise<number> {
	return measureBufferTruePeakDb(buffer, sampleRate);
}

/**
 * Classify one analysis window against the whole-signal 4× true peak.
 *
 * Pure, no `this`, no I/O — takes the window's PER-CHANNEL samples, the
 * sample rate (so the window's own 4× true peak can be measured —
 * {@link measureFrameTruePeakDb}, a fresh cold accumulator per call by
 * that function's contract), the pre-measured global 4× true peak (dB),
 * and whether this is the frame containing the file's global 4× true
 * peak; returns the {@link WindowBinding}: *binding* iff (a) the
 * channel-sum window's VERBATIM {@link peakPriorityAmount} exceeds
 * {@link BINDING_HEADROOM_MIN} (phase-only-recoverable crest headroom)
 * AND (b) the window's own 4× true peak is within {@link BINDING_DELTA_DB}
 * of the global 4× true peak (proximity, SAME true-peak domain — the
 * 2026-05-17 keystone correction) OR `isGlobalTpFrame` (force-bind the
 * frame that determines the file's 4× true peak — robust to per-frame
 * cold-history TP undercount) — plus the channel-sum peak metadata (the
 * per-peak-exact hold / Item-7 φ′ proposal target) and the measured
 * headroom + frame 4× true peak.
 *
 * A non-binding window is one where acting cannot move the file's true
 * peak — its own 4× true peak is more than the binding delta below the
 * file's 4× true peak (and it is not the global-TP frame), OR it has no
 * phase-only-recoverable crest headroom (a phase-only all-pass cannot
 * flatten an already-limited / zero-headroom window's true peak —
 * §Algorithm Specification Item 10). It is flagged EXACT identity
 * (`binding: false`).
 *
 * @param channelWindows The analysis window's PER-CHANNEL samples (each
 *   length = the analysis frame size). The channel-SUM (the linked-
 *   stereo sum the trajectory is fitted from) is derived here for the
 *   headroom + peak metadata; the per-channel windows feed the window's
 *   own 4× true-peak measurement.
 * @param globalTruePeakDb The whole-signal 4× true peak (dBTP) from
 *   {@link measureWholeSignalTruePeakDb}.
 * @param sampleRate The runtime sample rate (Hz) — for the window's own
 *   {@link measureFrameTruePeakDb}.
 * @param isGlobalTpFrame `true` iff this is the analysis frame
 *   containing the file's global 4× true peak (force-bind).
 */
export function classifyWindow(channelWindows: ReadonlyArray<Float32Array>, globalTruePeakDb: number, sampleRate: number, isGlobalTpFrame = false): WindowBinding {
	const length = channelWindows[0]?.length ?? 0;
	const channelCount = channelWindows.length;

	if (length === 0 || channelCount === 0) return { binding: false, peakIndex: -1, peakValue: 0, peakMagnitude: 0, headroom: 0, frameTruePeakDb: measureFrameTruePeakDb([], sampleRate) };

	// The channel-SUM window (the linked-stereo sum — the SAME array the
	// trajectory fit / `peakPriorityAmount` / the per-peak-exact `n_i`
	// consume; iterative Float32 channel-add, matching the driver).
	const sumWindow = new Float32Array(length);

	for (const channelWindow of channelWindows) {
		const limit = Math.min(length, channelWindow.length);

		for (let position = 0; position < limit; position++) sumWindow[position] = Math.fround((sumWindow[position] ?? 0) + (channelWindow[position] ?? 0));
	}

	let peakMagnitude = 0;
	let peakIndex = 0;
	let peakValue = 0;

	for (let position = 0; position < length; position++) {
		const value = sumWindow[position] ?? 0;
		const magnitude = value < 0 ? -value : value;

		if (magnitude > peakMagnitude) {
			peakMagnitude = magnitude;
			peakIndex = position;
			peakValue = value;
		}
	}

	// (b) HEADROOM — the VERBATIM `peakPriorityAmount` on the channel-sum
	// window (composed, never re-implemented; bit-identical to the value
	// the trajectory driver fits with for this frame). ≈0 ⇒ no
	// phase-only-recoverable crest headroom ⇒ a phase-only all-pass
	// cannot move this window's true peak ⇒ non-binding (Item 10).
	const headroom = peakPriorityAmount(sumWindow, 0, length);

	// The window's OWN per-channel 4× true peak — the proximity LHS now
	// in the SAME true-peak domain as the global number (the 2026-05-17
	// keystone correction; a fresh cold accumulator per call by
	// `measureFrameTruePeakDb`'s contract).
	const frameTruePeakDb = measureFrameTruePeakDb(channelWindows, sampleRate);
	const binding = isBindingPeak(frameTruePeakDb, headroom, globalTruePeakDb, isGlobalTpFrame);

	return { binding, peakIndex, peakValue, peakMagnitude, headroom, frameTruePeakDb };
}

/**
 * The binding predicate on already-measured per-window metadata — the
 * EXACT same headroom-AND-(TP-proximity-OR-force-bind) rule as
 * {@link classifyWindow}, factored so the streaming trajectory driver
 * can classify each frame from the per-frame 4× true peak / headroom it
 * already computed (zero extra cost; bit-identical to
 * {@link classifyWindow} on the same window). Pure, no `this`, no I/O.
 *
 * @param frameTruePeakDb The window's own per-channel 4× true peak
 *   (dBTP) — {@link measureFrameTruePeakDb} of the per-channel windows.
 * @param headroom The window's VERBATIM `peakPriorityAmount` (∈ [0,1]).
 * @param globalTruePeakDb The whole-signal 4× true peak (dBTP) from
 *   {@link measureWholeSignalTruePeakDb}.
 * @param isGlobalTpFrame `true` iff this is the analysis frame
 *   containing the file's global 4× true peak (force-bind).
 * @returns `true` iff binding ( headroom AND ( 4×-TP-proximity OR
 *   force-bind ) ).
 */
export function isBindingPeak(frameTruePeakDb: number, headroom: number, globalTruePeakDb: number, isGlobalTpFrame = false): boolean {
	// SAME true-peak domain on both sides (the 2026-05-17 keystone fix —
	// the old raw summed-sample LHS was a different domain). The
	// `measureFrameTruePeakDb` silence floor (−200 dB) for a silent
	// window can never be within BINDING_DELTA_DB of a real global true
	// peak ⇒ silent windows are correctly non-binding.
	const proximate = frameTruePeakDb >= globalTruePeakDb - BINDING_DELTA_DB;

	return headroom > BINDING_HEADROOM_MIN && (proximate || isGlobalTpFrame);
}
