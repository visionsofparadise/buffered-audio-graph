// The crestReduce per-frame control-trajectory TYPE + the
// PER-PEAK-EXACT DECORRELATION-AMOUNT-ENVELOPE smoother.
//
// Phase 8 (plan-crest-reduce-envelope-v2.md `### 8.2`, the
// user-authoritative 2026-05-17 control-envelope CORRECTION) restored the
// bidirectionally-smoothed decorrelation envelope + the `smoothing`
// parameter. Several prior reconstructions were defective:
//   * 8.2 bare-IIR: a bare per-lane bidirectional IIR over a hard
//     0/spike per-lane reflection-coefficient envelope averaged each
//     isolated Item-7 spike away → a bit-identical no-op on real content
//     (episode-060 0.00 dB ΔTP at s1 AND s0.5).
//   * scalar peak-respecting builds (max-hold → bidirectional, with /
//     without a stage-3 clamp): eliminated the no-op but made
//     whole-signal true-peak reduction DEPEND ON `smoothing` — the peak
//     was getting a SMOOTHED APPROXIMATION summed out of two passes, not
//     the EXACT per-peak Item-7 optimal.
//   * the GEOMETRY-FIXED exactness hold centered on the ANALYSIS FRAME
//     (`slidingWindowMax(amountEnv, ceil(frameSize/hopSize))`): the
//     plateau was mis-centered on `f0` (not the peak sample) and ~10×
//     too wide (the STFT-overlap span) — "holding a value over audio
//     that doesn't need it". Applied undiluted over that wide mis-placed
//     plateau the cross-window dispersion raised the whole-signal 4× TP
//     on episode-060 and the (then-present) whole-signal never-worsen
//     veto floored the whole candidate to a bit-identical no-op.
//
// THE USER'S AUTHORITATIVE ARCHITECTURAL CORRECTION (verbatim,
// 2026-05-17): "so we have two smoothed passes. at each peak we should be
// calculating optimal decorrelation to apply. can you guarantee that by
// the time the peak comes around, that exact decorrelation value is
// applied, and not an approximation summed from the two passes? smoothing
// should not be affecting reduction in any way if this is the case. the
// smoothing parameter's only effect is decorrelation spill over into
// gated segments or smoothing between values". Binding: the EXACT Item-7
// per-window optimal MUST be applied at every binding peak (undiluted by
// the bidirectional IIR); `smoothing` must NOT affect whole-signal
// true-peak reduction at all; `smoothing`'s ONLY effects are (a)
// decorrelation spill into the gated (non-active) segments and (b) easing
// between active values.
//
// THE NEVER-WORSEN MODEL (user-authoritative, LOCKED 2026-05-17): there
// is exactly ONE never-worsen and it is INTRINSIC to the per-window
// commit-only-if-better of the DETERMINISTIC minimiser (`searchBindingPeak`
// + Parker–Välimäki §III-A read per-window: the committed scale never
// raises THAT window's own peak FOR THE ISOLATED search evaluation;
// identity is its floor). SCOPE CAVEAT (known-issue B, measured): this is
// NOT bit-strict on the rendered output — production is a stateful
// frame-interpolated lattice, so the realised per-window 4× TP can
// marginally exceed identity (≈5% of binding windows on episode-060) —
// see `search.ts` `searchBindingPeak` SCOPE CAVEAT. There is NO
// whole-signal never-worsen: the earlier `_process` single-pass veto was
// a MISINTERPRETATION (never a real contract) and has been REMOVED.
// `_process` now always emits the gated + smoothed lattice output.
//
// THE CORRECTED ARCHITECTURE (this file). The control trajectory is the
// SCALAR decorrelation-AMOUNT envelope (`amountEnv[frame]`, non-negative
// — 0 at a non-active frame, the Item-7-committed `searchBindingPeak`
// scale at an active-band peak frame) plus the per-frame base dispersive
// design row (`baseRows[frame]` — the Abel & Smith / RMV step-down fit
// for THAT frame's spectrum, present every frame) plus the per-frame
// ABSOLUTE peak-sample index (`peakSampleIndex[frame]` — `n_i`, where the
// window's max |channel-sum| actually sits). The streaming driver
// (`windowed.ts` `streamLatticeTrajectory`, UNCHANGED gate + Item-7
// search) carries all three. `smoothControlTrajectory` combines, by
// `max`, TWO INDEPENDENT components on the scalar `amountEnv`:
//
//   1. PER-PEAK EXACT-OPTIMAL FLAT HOLD (NOT tied to `smoothing`),
//      centered on the PEAK SAMPLE. For every binding frame
//      (`amountEnv[f] > 0`) the committed Item-7 optimal is held FLAT
//      across the trajectory frames `[round(n_i/hop) − Wexact,
//      round(n_i/hop) + Wexact]` — centered on `round(n_i / hopSize)`,
//      the trajectory frame `streamLatticeApply`'s `framePos = sample /
//      hopSize` map interpolates the PEAK SAMPLE from (NOT the analysis
//      frame `f0`; NOT the STFT-overlap span). Where two peaks' holds
//      overlap take the `max`. Half-width
//        `Wexact = max(1, ceil((GROUP_DELAY_CEILING_MS/1000 ·
//                  sampleRate) / hopSize) + 1)`
//      — the decorrelation's OWN group-delay span (the transparency
//      ceiling `GROUP_DELAY_CEILING_MS = 4.0 ms`, the SAME bound the
//      frozen `search.ts` λ-map uses; imported, NOT redeclared) expressed
//      in trajectory frames, +1 so the peak sample's interpolation
//      bracket `⌊n_i/hop⌋…⌈n_i/hop⌉` is fully inside the flat hold.
//      WHY this pins the exact optimal AT the peak (load-bearing —
//      preserve): Item-7 optimises a *static* all-pass for the window,
//      but the production lattice (`processLatticeChannel`) is
//      *time-varying* and *causal* (a recursive IIR). For the realised
//      filter to EQUAL the computed optimum at the peak the coefficient
//      must be flat at the optimal across the filter's own time-support
//      around the peak — a settling lead-in BEFORE the peak (so the
//      recursive state is the optimal all-pass's steady state) PLUS the
//      causal dispersion span AFTER it (the peak's energy is smeared
//      forward over the group delay). Hence the hold is AROUND the peak
//      (both sides), half-width = the group-delay span, bounded by the
//      transparency ceiling. `Wexact` depends ONLY on the group-delay
//      ceiling + analysis geometry (`sampleRate`/`hopSize`) — NEVER on
//      `smoothingMs`. Whole-signal true-peak reduction is therefore
//      determined SOLELY by the exact per-peak Item-7 optimal and is
//      INDEPENDENT of `smoothing`.
//   2. SMOOTHING-DRIVEN SPILL (tied to `smoothing`): the
//      transient-asymmetry pullback pre-pass (unchanged) → `iirSpill =
//      BidirectionalIir({ smoothingMs, sampleRate: frameRate })
//      .applyBidirectional(pulled)` — the bidirectional zero-phase pass
//      on the (pulled) `amountEnv`, NOT on the exact hold. This is the
//      ONLY `smoothing`-dependent term.
//   3. COMBINE: `final[f] = max(exactHold[f], iirSpill[f])`. Within
//      `±Wexact` of any binding peak's `n_i` `exactHold` is the flat
//      exact optimal and the bidirectional IIR (which only eases the raw
//      spikes DOWN) cannot exceed it → EXACT optimal, smoothing-invariant.
//      Across long gated stretches `exactHold = 0` and `iirSpill` decays
//      to 0 → settle-to-0. Between close / ungapped peaks the IIR spill
//      overlaps into a smooth non-zero gradient → gradient-between-peaks.
//      `smoothing` solely controls the spill reach / inter-peak gradient.
//      Exactly the user's model.
//
// Each frame's control row is then reconstructed `row[f] = final[f] ·
// baseRow[f]` — a non-active region away from any peak (final ≈ 0) ⇒ an
// identity row (a crest-invariant pure delay), within a peak's ±Wexact
// hold ⇒ the EXACT Item-7 optimal × that frame's dispersive design, in
// the gaps ⇒ the `smoothing`-eased spill × the design row. The
// reconstructed `ControlTrajectory.rows` is the SAME shape
// `streamLatticeApply` consumes (unchanged contract).
//
// HARD RULE (design-crest-reduce.md §Rejected Approaches "Bidirectional /
// zero-phase pass on the audio all-pass"): every envelope op here (the
// per-peak hold spread, the transient pullback, `BidirectionalIir`) is on
// the FRAME-indexed scalar / row arrays ONLY — NEVER the audio path.
// Forward-backward filtering an all-pass yields |H|² = 1 / zero net phase
// = identity, cancelling exactly the phase manipulation that is the
// entire mechanism. `streamLatticeApply` has ZERO `BidirectionalIir` /
// envelope reference.
//
// Zero-phase mechanism reuse: the single-source-of-truth
// `BidirectionalIir` from `@buffered-audio/utils` — the EXACT
// primitive `loudnessTarget`'s peak-respecting gain envelope uses
// (`loudness-target/utils/envelope.ts`). The √2·τ
// bidirectional-vs-causal compensation (so the user-facing `smoothing` ms
// maps to a single-causal-pass magnitude response) is INTERNAL to
// `BidirectionalIir` (`tauBidirectional = (smoothingMs/1000) ·
// Math.SQRT2`) — it is NOT re-applied here (double-compensating would be
// wrong). The SPILL IIR runs on the trajectory's FRAME-RATE axis
// (`sampleRate / hopSize`, one trajectory sample per analysis hop) so the
// `smoothing` ms has a consistent magnitude-response meaning. The
// per-peak exact-hold half-width is `Wexact` (from `GROUP_DELAY_CEILING_MS`
// + `sampleRate`/`hopSize`, NOT `smoothing`) — see
// `exactHoldHalfWidthFrames`.

import { BidirectionalIir } from "@buffered-audio/utils";
import { GROUP_DELAY_CEILING_MS } from "./search";

/**
 * A per-frame control trajectory. It has TWO faces:
 *
 *  - PRE-SMOOTHING (as built by `windowed.ts` `streamLatticeTrajectory`):
 *    the per-frame DECORRELATION-AMOUNT envelope. `baseRows[frame]` is the
 *    per-frame base dispersive design row (the Abel & Smith / RMV
 *    step-down fit for THAT frame's spectrum — present at EVERY frame,
 *    active or not). `amountEnv[frame]` is the non-negative scalar
 *    decorrelation amount: `0` at a non-active-band frame (envelope value
 *    0 — "for segments that do not have peaks in the active band the
 *    value should be 0"), the Item-7-search committed scale at an
 *    active-band peak frame ("for peaks in the active band we calculate
 *    the optimal value"). `peakSampleIndex[frame]` is the absolute
 *    peak-sample index `n_i` for that frame's window. `rows` is the
 *    empty/unused placeholder here.
 *  - POST-SMOOTHING (returned by `smoothControlTrajectory`): `rows[frame]`
 *    is the reconstructed control vector `finalAmount[frame] ·
 *    baseRow[frame]` (length `laneCount`) — the normalized-lattice
 *    section reflection coefficients `streamLatticeApply` consumes. A
 *    non-active region's row is ≈`identity` (all-zero — a crest-invariant
 *    M-sample delay; see `processLatticeChannel`'s identity contract);
 *    within a peak's ±Wexact hold the row is the EXACT Item-7 optimal ×
 *    that frame's dispersive design.
 *
 * `baseRows` / `amountEnv` / `peakSampleIndex` are carried through
 * `smoothControlTrajectory` unchanged (the smoother reads them to
 * reconstruct `rows`); they are node-local and never reach
 * `streamLatticeApply` (which only reads `rows` / `identity`).
 */
export interface ControlTrajectory {
	/**
	 * POST-SMOOTHING: the reconstructed per-frame control vector
	 * (`finalAmount · baseRow`, length `laneCount`) that
	 * `streamLatticeApply` / `processLatticeChannel` consume. The as-built
	 * no-search analysis path (`lattice.ts` `extractLatticeTrajectory`,
	 * byte-frozen) also populates `rows` directly (the topology tests).
	 * PRE-SMOOTHING from `streamLatticeTrajectory`: an empty array (the
	 * driver builds `baseRows` + `amountEnv` + `peakSampleIndex`;
	 * `smoothControlTrajectory` produces `rows`).
	 */
	readonly rows: ReadonlyArray<Float32Array>;
	/**
	 * Per-frame BASE dispersive design row (length `laneCount`) — the
	 * Abel & Smith (Item 9) + RMV §III step-down (Item 8) reflection-
	 * coefficient fit for THAT frame's spectrum, present at EVERY frame
	 * (active or not). The decorrelation amount scales THIS row; the
	 * committed active-frame row is `amountEnv[f] · baseRows[f]`
	 * (bit-identical to the Item-7 `result.scale · row` the search
	 * committed). `smoothControlTrajectory` reconstructs each smoothed row
	 * as `finalAmount[f] · baseRows[f]`.
	 *
	 * OPTIONAL on the type so the byte-frozen as-built no-search analysis
	 * path (`lattice.ts` `extractLatticeTrajectory`) and the lattice
	 * topology tests — which build a `rows`-only `ControlTrajectory` and
	 * never call `smoothControlTrajectory` — typecheck unchanged.
	 * `streamLatticeTrajectory` ALWAYS populates it (the production
	 * decorrelation-envelope path); `smoothControlTrajectory` requires it
	 * (it is only ever called on a `streamLatticeTrajectory` result).
	 */
	readonly baseRows?: ReadonlyArray<Float32Array>;
	/**
	 * Per-frame SCALAR decorrelation amount (non-negative). `0` at a
	 * non-active-band frame (the gate is false — envelope value 0); the
	 * Item-7-search committed scale (`searchBindingPeak(...).scale`,
	 * `0 ≤ scale < λ < 1` — non-negative; the project's real-coefficient
	 * analogue of Hong's `c`) at an active-band peak frame. This is the
	 * "decorrelation envelope … value" the user-authoritative model
	 * smooths. `smoothControlTrajectory` combines, by `max`, a per-peak
	 * EXACT-OPTIMAL flat hold of THIS scalar (centered on the peak SAMPLE
	 * `n_i`, half-width `Wexact` from `GROUP_DELAY_CEILING_MS` +
	 * `sampleRate`/`hopSize` — pins the exact Item-7 optimal at the peak,
	 * `smoothing`-INVARIANT) with a `smoothing`-driven bidirectional spill
	 * (transient pullback → `BidirectionalIir` on THIS scalar) — the only
	 * `smoothing`-dependent term, controlling solely spill into gated gaps
	 * + the gradient between ungapped values.
	 *
	 * OPTIONAL on the type for the same reason as `baseRows` (the byte-
	 * frozen `rows`-only as-built path). `streamLatticeTrajectory` ALWAYS
	 * populates it.
	 */
	readonly amountEnv?: Float32Array;
	readonly laneCount: number;
	/**
	 * The identity control vector (length `laneCount`) — all-zero
	 * reflection coefficients. A frame fully at `identity` applies the
	 * trivial all-pass (an exact integer M-sample delay — crest-
	 * invariant, NOT sample-exact; see `processLatticeChannel`). The
	 * envelope's value 0 (a non-active-band frame).
	 */
	readonly identity: Float32Array;
	/**
	 * Per-frame transient indicator in `[0, 1]`: 1 = a detected transient
	 * (a sharp inter-frame energy rise) at this frame, 0 = stationary.
	 * Populated by the analysis walk (`utils/windowed.ts`
	 * `streamLatticeTrajectory`). `smoothControlTrajectory` reads it for
	 * the transient-asymmetry PULLBACK pre-pass that feeds ONLY the
	 * `smoothing`-driven bidirectional SPILL term (pull the SCALAR amount
	 * toward 0 at flagged onsets BEFORE the bidirectional IIR so a sharp
	 * transient is not pre-smeared by the backward pass — the as-built
	 * behaviour, now on the scalar; it does NOT affect the per-peak exact
	 * hold, which holds the raw exact optimal).
	 */
	readonly transientMask: Float32Array;
	/**
	 * Per-frame ABSOLUTE peak-sample index `n_i` (the 2026-05-17
	 * user-authoritative per-peak-exact CORRECTION). For frame `f`,
	 * `peakSampleIndex[f]` is the absolute signal-sample index of that
	 * analysis window's max |channel-sum| — `f·hopSize + argmax_pos`,
	 * where `argmax_pos ∈ [0, frameSize)` is the position WITHIN the
	 * window of that max (the windowed.ts walk already scans the window
	 * for max |sample| to populate `WindowPeak.peakMagnitude`; it now also
	 * records the argmax index — zero extra cost, informational metadata,
	 * NO edit to the byte-frozen `binding.ts`/`search.ts`).
	 *
	 * `smoothControlTrajectory` centers each binding peak's EXACT-OPTIMAL
	 * flat hold on `round(n_i / hopSize)` (the trajectory frame the peak
	 * SAMPLE interpolates from in `streamLatticeApply`'s `framePos =
	 * sample / hopSize` map) — NOT on the analysis frame `f0` and NOT the
	 * STFT-overlap span (which mis-centers ~10× too wide; the rejected
	 * "holding a value over audio that doesn't need it"). The hold is
	 * `[round(n_i/hop) − Wexact, round(n_i/hop) + Wexact]` (BOTH sides of
	 * the peak sample), `Wexact` from the group-delay ceiling + analysis
	 * geometry only (NEVER `smoothingMs`).
	 *
	 * OPTIONAL on the type for the same reason as `baseRows`/`amountEnv`
	 * (the byte-frozen `rows`-only as-built no-search path that never
	 * reaches `smoothControlTrajectory`). `streamLatticeTrajectory`
	 * ALWAYS populates it.
	 */
	readonly peakSampleIndex?: Int32Array;
}

/**
 * The transient-asymmetry PULLBACK fraction (project glue, declared — NOT
 * a sourced constant). At a frame flagged transient (`transientMask` = 1)
 * the SCALAR decorrelation amount is pulled a fraction `TRANSIENT_PULLBACK`
 * of the way toward 0 BEFORE the `smoothing`-driven bidirectional
 * zero-phase SPILL pass (component 2), so the (acausal) backward pass does
 * not pre-smear dispersion across a sharp onset (the as-built behaviour
 * reconstructed from the predecessor plan-crest-reduce.md Phase-5F Notes +
 * the design-crest-reduce.md "As-built single-realization reframed
 * implementation" Decision: "transient-asymmetry pullback toward identity
 * at flagged onsets THEN … zero-phase smoothing"). It feeds ONLY the
 * spill term — the per-peak exact hold (component 1) holds the RAW exact
 * Item-7 optimal so the exact peak value is never pulled. 0.5 = halve the
 * amount at a flagged onset; it is the project's own declared QA-tuned
 * operating value, not a transcribed literature constant, and it is not a
 * user surface (the v2 user dial for envelope easing is `smoothing`).
 */
export const TRANSIENT_PULLBACK = 0.5;

/**
 * The trajectory's FRAME-RATE axis sample rate (Hz): one trajectory
 * sample per analysis hop, so the bidirectional IIR's `smoothing` ms maps
 * to a consistent magnitude response regardless of `frameSize`/`hopSize`.
 * `sampleRate / hopSize`. Floored to a positive finite value (a
 * degenerate hop ⇒ 1 so the IIR is well-formed; the caller never feeds a
 * non-positive hop in practice).
 *
 * @param sampleRate Runtime audio sample rate (Hz).
 * @param hopSize Analysis hop in samples.
 */
export function trajectoryFrameRate(sampleRate: number, hopSize: number): number {
	if (!(sampleRate > 0) || !(hopSize > 0)) return 1;

	const rate = sampleRate / hopSize;

	return rate > 0 && Number.isFinite(rate) ? rate : 1;
}

/**
 * Half-width `Wexact` (in trajectory FRAMES) of the per-peak EXACT-OPTIMAL
 * flat hold — the decorrelation's OWN group-delay span around the peak,
 * bounded by the transparency ceiling:
 *
 *   `Wexact = max(1, ceil((GROUP_DELAY_CEILING_MS/1000 · sampleRate) /
 *             hopSize) + 1)`
 *
 * It depends ONLY on the group-delay ceiling + analysis geometry
 * (`sampleRate`/`hopSize`) and is NEVER a function of `smoothingMs`.
 *
 * WHY the group-delay span on BOTH sides of the peak (load-bearing —
 * preserve): Item-7 (`search.ts`, frozen) optimises a *static* all-pass
 * for the window; the production lattice (`processLatticeChannel`) is
 * *time-varying* and *causal* (a recursive IIR). For the realised filter
 * to EQUAL the computed optimum the coefficient must be flat at the
 * optimal across the filter's own time-support around the peak — a
 * settling lead-in BEFORE the peak (so the recursive state is the optimal
 * all-pass's steady state) PLUS the causal dispersion span AFTER it (the
 * peak's energy is smeared forward over the group delay). So the hold is
 * AROUND the peak (both sides), half-width = the group-delay span, bounded
 * by `GROUP_DELAY_CEILING_MS` (= 4.0 ms — the SAME transparency ceiling
 * the frozen `search.ts` λ-map uses; imported from `search.ts`, NOT
 * redeclared, so it tracks the frozen ceiling automatically). The `+1`
 * guarantees the peak sample's frame→sample interpolation bracket
 * `⌊n_i/hop⌋…⌈n_i/hop⌉` is fully inside the flat hold (both
 * `streamLatticeApply` interpolation endpoints sit on the plateau, so the
 * interpolated row AT the peak equals the exact optimal). The window each
 * peak's hold spans is `[round(n_i/hop) − Wexact, round(n_i/hop) +
 * Wexact]` (total `2·Wexact + 1` frames), centered on the PEAK SAMPLE,
 * NOT the analysis frame f0 and NOT the STFT-overlap span. Floor of 1
 * frame for a degenerate geometry (covers the immediate ±1 interpolation
 * neighbours).
 *
 * @param sampleRate Runtime audio sample rate (Hz).
 * @param hopSize Analysis hop in samples.
 */
export function exactHoldHalfWidthFrames(sampleRate: number, hopSize: number): number {
	if (!(sampleRate > 0) || !(hopSize > 0)) return 1;

	// The group-delay transparency ceiling expressed at the sample rate
	// (samples) — a bound computed from the sample rate, NOT a transcribed
	// constant (`GROUP_DELAY_CEILING_MS` is the SAME project-glue value the
	// frozen `search.ts` λ-map uses; imported so it tracks that ceiling).
	const ceilingSamples = (GROUP_DELAY_CEILING_MS / 1000) * sampleRate;

	return Math.max(1, Math.ceil(ceilingSamples / hopSize) + 1);
}

/**
 * Combine the per-frame SCALAR DECORRELATION-AMOUNT envelope into the
 * final smoothed control trajectory by `max` of TWO INDEPENDENT
 * components, then reconstruct each frame's control row as
 * `finalAmount · baseRow`. This is the 2026-05-17 USER-AUTHORITATIVE
 * PER-PEAK-EXACT ARCHITECTURAL CORRECTION (verbatim: "at each peak we
 * should be calculating optimal decorrelation to apply. can you guarantee
 * that by the time the peak comes around, that exact decorrelation value
 * is applied, and not an approximation summed from the two passes?
 * smoothing should not be affecting reduction in any way if this is the
 * case. the smoothing parameter's only effect is decorrelation spill over
 * into gated segments or smoothing between values"). The two components,
 * on the SCALAR `amountEnv` over the FRAME axis:
 *
 *   1. PER-PEAK EXACT-OPTIMAL FLAT HOLD (NOT tied to `smoothing`),
 *      centered on the PEAK SAMPLE. For every binding frame
 *      (`amountEnv[f] > 0`) the committed Item-7 optimal `amountEnv[f]`
 *      is held FLAT across the trajectory frames `[c − Wexact, c +
 *      Wexact]` where `c = round(peakSampleIndex[f] / hopSize)` — the
 *      trajectory frame `streamLatticeApply`'s `framePos = sample /
 *      hopSize` map interpolates the PEAK SAMPLE `n_i` from. Where two
 *      peaks' holds overlap take the `max` (this, combined with the IIR,
 *      yields the gradient-between-ungapped-peaks behaviour). The plateau
 *      is centered on the PEAK SAMPLE, NOT the analysis frame `f0` and
 *      NOT the STFT-overlap span (which mis-centers ~10× too wide — the
 *      rejected "holding a value over audio that doesn't need it").
 *      `Wexact = exactHoldHalfWidthFrames(sampleRate, hopSize)` — the
 *      decorrelation's own group-delay span (`GROUP_DELAY_CEILING_MS` +
 *      analysis geometry), NEVER `smoothingMs`. WHY a flat hold around
 *      the peak makes the realised (time-varying, causal IIR) lattice
 *      apply the EXACT static Item-7 optimum at the peak: a settling
 *      lead-in BEFORE the peak (recursive state = the optimal all-pass's
 *      steady state) PLUS the causal dispersion span AFTER it (the peak's
 *      energy smeared forward over the group delay) — see
 *      `exactHoldHalfWidthFrames`. Whole-signal true-peak reduction is
 *      therefore the exact per-peak optimal and INDEPENDENT of
 *      `smoothing`.
 *   2. SMOOTHING-DRIVEN SPILL (tied to `smoothing`).
 *      2a. TRANSIENT-ASYMMETRY PULLBACK (pre-pass, unchanged): at every
 *          frame flagged transient (`transientMask[frame]` = 1) the
 *          scalar amount is pulled `TRANSIENT_PULLBACK` toward 0 BEFORE
 *          the IIR so the acausal backward pass does not pre-smear an
 *          onset. Working copy — the input `amountEnv` is not mutated.
 *          (It feeds ONLY this spill term — the exact hold uses the RAW
 *          `amountEnv` so the exact peak value is never pulled.)
 *      2b. BIDIRECTIONAL ZERO-PHASE IIR on the PULLED scalar:
 *          `iirSpill = BidirectionalIir({ smoothingMs, sampleRate:
 *          frameRate }).applyBidirectional(pulled)` — forward THEN
 *          backward one-pole (zero net phase; the √2·τ compensation is
 *          INTERNAL to `BidirectionalIir`, NOT re-applied). This is the
 *          ONLY `smoothing`-dependent term. It runs on the (pulled)
 *          `amountEnv`, NOT on the exact hold. At `smoothingMs <= 0`
 *          `applyBidirectional` is identity (a fresh copy of `pulled`).
 *   3. COMBINE per frame: `finalAmount[f] = max(exactHold[f],
 *      iirSpill[f])`. Within `±Wexact` of any binding peak's `n_i`
 *      `exactHold` is the flat exact optimal and the bidirectional IIR
 *      (which only eases the raw spikes DOWN) cannot exceed it → the
 *      EXACT optimal is applied, smoothing-INVARIANT. Across long gated
 *      stretches `exactHold = 0` and `iirSpill` decays to 0 →
 *      settle-to-0. Between close / ungapped peaks the IIR spill overlaps
 *      into a smooth non-zero gradient → gradient-between-peaks.
 *      `smoothing` solely controls the spill reach + the inter-peak
 *      gradient. Exactly the user's model.
 *
 * Then per frame `rows[f] = finalAmount[f] · baseRows[f]`: a non-active
 * region away from any peak (`finalAmount ≈ 0`) ⇒ an identity row (a
 * crest-invariant pure delay); within a peak's ±Wexact hold ⇒ the EXACT
 * Item-7 optimal × that frame's dispersive design (bit-faithful to the
 * committed `result.scale · row`); in the gaps ⇒ the `smoothing`-eased
 * spill × that frame's dispersive design.
 *
 * Returns a NEW `ControlTrajectory` with the reconstructed `rows` (the
 * shape `streamLatticeApply` consumes); the input is not mutated.
 * `baseRows` / `amountEnv` / `peakSampleIndex` / `identity` /
 * `laneCount` / `transientMask` are carried through unchanged.
 *
 * HARD RULE (design §Rejected Approaches): this operates EXCLUSIVELY on
 * the frame-indexed scalar / row arrays — the per-peak hold spread, the
 * transient pullback, and `BidirectionalIir` are NEVER applied to the
 * audio (forward-backward an all-pass = identity, cancelling the
 * mechanism).
 *
 * @param trajectory The gated decorrelation-amount envelope (per-frame
 *   `baseRows` + the scalar `amountEnv`: 0 at a non-active frame, the
 *   Item-7 committed scale at an active-band peak frame; +
 *   `peakSampleIndex` `n_i`), as built by `windowed.ts`
 *   `streamLatticeTrajectory`.
 * @param smoothingMs The user `smoothing` parameter (ms). Affects ONLY
 *   the spill term (component 2); whole-signal true-peak reduction is
 *   `smoothing`-INVARIANT (component 1 pins the exact per-peak optimal).
 *   0 ⇒ no IIR spill (`iirSpill = pulled`); the exact hold still applies.
 * @param frameRate The trajectory frame-rate axis sample rate (Hz) —
 *   `trajectoryFrameRate(sampleRate, hopSize)`. Drives ONLY the spill
 *   IIR's `smoothing`-ms magnitude mapping.
 * @param exactHoldFrames The per-peak exact-hold half-width `Wexact =
 *   exactHoldHalfWidthFrames(sampleRate, hopSize)`. Passed in (not
 *   recomputed) so the caller threads the group-delay ceiling + analysis
 *   geometry; it must NOT depend on `smoothingMs`.
 * @param hopSize Analysis hop in samples — maps each binding peak's
 *   absolute sample `n_i` to its trajectory frame `round(n_i / hopSize)`
 *   (the frame `streamLatticeApply` interpolates the peak sample from).
 */
export function smoothControlTrajectory(
	trajectory: ControlTrajectory,
	smoothingMs: number,
	frameRate: number,
	exactHoldFrames: number,
	hopSize: number,
): ControlTrajectory {
	// CONTRACT: `smoothControlTrajectory` is only ever called on a
	// `streamLatticeTrajectory` result, which ALWAYS populates `baseRows`
	// + `amountEnv` + `peakSampleIndex` (the pre-smoothing decorrelation-
	// amount envelope). The fields are OPTIONAL on the type only so the
	// byte-frozen `rows`-only as-built no-search path (`lattice.ts`
	// `extractLatticeTrajectory`) typechecks unchanged; that path never
	// reaches here. A missing field here would be a wiring bug — narrow to
	// the guaranteed-present arrays (an empty trajectory is the only
	// well-defined absence and is handled below).
	const baseRows = trajectory.baseRows ?? [];
	const amountEnv = trajectory.amountEnv ?? new Float32Array(0);
	const peakSampleIndex = trajectory.peakSampleIndex ?? new Int32Array(0);
	const frameCount = baseRows.length;
	const laneCount = trajectory.laneCount;

	if (frameCount === 0 || laneCount === 0) {
		return {
			rows: [],
			baseRows,
			amountEnv,
			laneCount,
			identity: trajectory.identity,
			transientMask: trajectory.transientMask,
			peakSampleIndex,
		};
	}

	const transientMask = trajectory.transientMask;
	const identity = trajectory.identity;
	// `Wexact` floored to a positive integer (the caller passes
	// `exactHoldHalfWidthFrames(...)` ≥ 1; guard a degenerate value).
	const halfWidth = Math.max(1, Math.floor(exactHoldFrames));
	const hop = hopSize > 0 ? hopSize : 1;

	// --- Component 1: PER-PEAK EXACT-OPTIMAL FLAT HOLD (NOT `smoothing`) -
	// For every binding frame (`amountEnv[f] > 0`) hold its committed
	// Item-7 optimal FLAT across `[c − Wexact, c + Wexact]` where
	// `c = round(n_i / hop)` — the trajectory frame the PEAK SAMPLE
	// interpolates from in `streamLatticeApply`. Where holds overlap take
	// the `max`. This is NOT a `slidingWindowMax` over the analysis-frame
	// index (which mis-centers on `f0` and uses the wrong ~10×-too-wide
	// STFT-overlap span); it is an explicit spread centered on each peak
	// SAMPLE's trajectory frame, half-width = the group-delay span
	// `Wexact` (NEVER `smoothingMs`). The RAW `amountEnv` is used (NOT the
	// transient-pulled copy) so the exact Item-7 optimal reaches the peak
	// undiluted.
	const exactHeld = new Float32Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const amount = amountEnv[frame] ?? 0;

		if (amount <= 0) continue; // non-binding — no exact hold to spread

		// Center the flat hold on the trajectory frame the PEAK SAMPLE
		// interpolates from (`round(n_i / hop)`), NOT the analysis frame.
		const peakSample = peakSampleIndex[frame] ?? frame * hop;
		const center = Math.round(peakSample / hop);
		const lo = Math.max(0, center - halfWidth);
		const hi = Math.min(frameCount - 1, center + halfWidth);

		for (let held = lo; held <= hi; held++) {
			// Overlapping holds take the max (the exact optimal of the
			// stronger peak wins on overlap; combined with the IIR this
			// yields the gradient between ungapped peaks).
			if (amount > (exactHeld[held] ?? 0)) exactHeld[held] = amount;
		}
	}

	// --- Component 2: SMOOTHING-DRIVEN SPILL (the only `smoothing` term) -
	// 2a. Transient-asymmetry pullback pre-pass on the SCALAR (a working
	// copy — the input `amountEnv` is not mutated). At a flagged-transient
	// frame the scalar amount is pulled `TRANSIENT_PULLBACK` toward 0 so
	// the acausal backward pass below does not pre-smear a sharp onset.
	// This feeds ONLY the spill IIR — component 1 above used the RAW
	// `amountEnv`, so the exact peak value is never pulled.
	const pulled = new Float32Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const value = amountEnv[frame] ?? 0;
		const isTransient = (transientMask[frame] ?? 0) > 0;

		// value ← value + PULLBACK·(0 − value): pull a fraction of the way
		// toward 0 at the onset. The amount is non-negative so the pulled
		// value stays non-negative.
		pulled[frame] = isTransient ? value + TRANSIENT_PULLBACK * (0 - value) : value;
	}

	// 2b. Bidirectional zero-phase IIR on the PULLED scalar (NOT on the
	// exact hold). One `BidirectionalIir` (the single-source-of-truth
	// `loudnessTarget` gain-envelope smoother) on the FRAME-RATE axis (the
	// √2·τ bidirectional compensation is INTERNAL to the class). This is
	// the ONLY `smoothing`-dependent quantity. At `smoothingMs <= 0`
	// `applyBidirectional` returns a fresh copy of `pulled` (the
	// well-defined no-spill case). It is the spill into gated gaps + the
	// gradient between ungapped active values, NOT the peak's value
	// (component 1 owns that).
	const iir = new BidirectionalIir({ smoothingMs, sampleRate: frameRate });
	const iirSpill = iir.applyBidirectional(pulled);

	// --- Component 3: COMBINE by `max` ----------------------------------
	// `finalAmount[f] = max(exactHeld[f], iirSpill[f])`. Within `±Wexact`
	// of a binding peak's `n_i` `exactHeld` is the flat exact optimal and
	// the bidirectional IIR (only easing the raw spikes DOWN) cannot
	// exceed it → the EXACT Item-7 optimal is applied, smoothing-INVARIANT.
	// Across long gated stretches `exactHeld = 0` and `iirSpill` decays to
	// 0 → settle-to-0. Between close/ungapped peaks the spill overlaps
	// into a non-zero gradient → `smoothing` solely controls the spill
	// reach + inter-peak gradient.
	const finalAmount = new Float32Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		finalAmount[frame] = Math.max(exactHeld[frame] ?? 0, iirSpill[frame] ?? 0);
	}

	// --- Reconstruct each control row: finalAmount · baseRow -------------
	// A non-active region away from any peak (finalAmount ≈ 0) ⇒ an
	// ≈identity row (a crest-invariant pure delay). Within an active
	// peak's ±Wexact hold ⇒ the EXACT Item-7 optimal × that frame's
	// dispersive design (bit-faithful to the committed `result.scale ·
	// row`); in the gaps ⇒ the `smoothing`-eased spill × the design row.
	const rows: Array<Float32Array> = new Array<Float32Array>(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const base = baseRows[frame] ?? identity;
		const amount = finalAmount[frame] ?? 0;
		const row = new Float32Array(laneCount);

		for (let lane = 0; lane < laneCount; lane++) row[lane] = amount * (base[lane] ?? 0);

		rows[frame] = row;
	}

	return { rows, baseRows, amountEnv, laneCount, identity, transientMask, peakSampleIndex };
}
