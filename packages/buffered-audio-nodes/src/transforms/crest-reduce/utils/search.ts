// Node-local per-binding-peak Item-7 coefficient search + the
// group-delay→λ ceiling for crestReduce (NOT shared DSP — node-specific
// composition glue; the 2026-04-23 design-architecture boundary:
// reusable primitives live in buffered-audio-nodes-utils, node-specific
// composition stays node-local).
//
// ── 2026-05-17 KEYSTONE REWORK (user-directed, grounded diagnosis) ──
// `strength` is REMOVED from the public surface entirely (the node always
// applies the optimal value). Two changes here:
//   1. `strengthToLambda(strength, …)` → `groupDelayLambda(sampleRate,
//      order)`: the Item-7 stability bound λ is now ALWAYS the full
//      psychoacoustic-group-delay ceiling (the old λ_max — there is no
//      `strength` fraction). `strength` only ever set this λ over a
//      provably NON-monotone objective, making s0.5 actually WORSEN TP;
//      the user's decision is that there is no strength parameter.
//   2. The Item-7 commit objective is now the per-channel **4× true-peak
//      power across channels** (BS.1770-4 Annex 1), NOT the window's raw
//      sample peak. The previous raw-sample objective was blind to the
//      inter-sample overshoot that actually determines the file's 4× true
//      peak — so the committed value did not minimise the quantity the
//      node exists to reduce.
//   3. The per-peak optimal AMOUNT is now CALCULATED, not searched: the
//      Item-7 Newton-Raphson + `Math.random` re-acquire is REPLACED by a
//      DETERMINISTIC bounded 1-D minimiser over c∈[0,λ] (coarse uniform
//      grid + golden-section refine — see `searchBindingPeak`). The
//      objective is provably non-monotone and empirically MULTIMODAL
//      (episode-060: 6–15 interior minima/window) so NO closed form
//      exists; but c is BOUNDED so the optimum is computed reproducibly
//      (no RNG, no φ′). Beats the prior random Newton by ~0.5–1.8 dB and
//      removes its 0–1.8 dB run-to-run nondeterminism. Domain is [0,λ]
//      NON-NEGATIVE (downstream requires a non-negative amount; the prior
//      Newton could silently commit negative c — a latent bug fixed). The
//      Hong 2011 objective / η / commit-only-if-better lineage below is
//      UNCHANGED; only the iteration mechanism is superseded (formal
//      design write-back deferred to Phase 7).
//
// Phase 4 (plan-crest-reduce-envelope-v2.md) implements the LOAD-BEARING
// per-binding-peak adaptive coefficient search the as-built node silently
// skipped — §Algorithm Specification Item 7 (Hong, Kim & Har 2011 §3,
// IEICE Electronics Express 8(19):1633–1639, OA J-STAGE; read in full,
// transcribed verbatim — see design-crest-reduce.md §Algorithm
// Specification Item 7). Crest reduction is NON-MONOTONE in coefficient
// magnitude (§Algorithm Specification Item 10, Schlecht 2022 Eq. 2
// `arg min_{m,g} max_n |y_{m,g}(n)|`), so the optimum must be
// SEARCHED/EVALUATED, not taken from a single analytic value.
//
// ── ITEM 7 VERBATIM (Hong/Kim/Har 2011 §2.2 Eq. 1, §3 Eqs. 5–9) ──
// Stateful all-pass recurrence (Hong2011 Eq. 1):
//   p̃_c(n) = s̃(n−1) + c·s̃(n) − c*·p̃_c(n−1)        (s̃(−1)=p̃_c(−1)=0)
// Cost function (Hong2011 Eq. 5):
//   φ(c_i) = |p̃_{c_i}(n_i)|² − η ,
//   n_i = arg max_{N_c ≤ n ≤ N+N_c−1} |p̃_{c_i}(n)|²
//   ("The coefficient c_i satisfying φ(c_i) ≤ 0 is sought, since c_i
//    satisfying such condition leads to PAPR less than or equal to η.")
// Newton update (Hong2011 Eq. 6):
//   c_{i+1} = c_i − φ(c_i)/φ'(c_i)
//   φ'(c_i) = p̃*_{c_i}(n_i)·d_i(n_i) + p̃_{c_i}(n_i)·g_i(n_i)  (Eq. 7)
//   d_i(n_i) = s̃(n_i) − c*_i·d_i(n_i−1)                        (Eq. 8)
//   g_i(n_i) = −p̃*_{c_i}(n_i−1) − c_i·g_i(n_i−1)               (Eq. 9)
//   (boundary d_i(−1) = g_i(−1) = p̃*_{c_i}(−1) = 0)
// Stability bound (§3, verbatim): "The magnitude of the coefficient is
//   confined to |c_i| < λ, where 0 < λ < 1, to ensure that the pole of
//   the A2PF is within a unit circle for stability. If the magnitude of
//   c_{i+1} is larger than λ, c_{i+1} is randomly acquired by A e^{jΦ},
//   where A and Φ are uniformly distributed over 0 to λ and over 0 to
//   2π." "The c_0 is set to zero and then the PAPR is checked whether it
//   satisfies the target PAPR. If so, [the update] is skipped and next
//   OFDM symbol is considered." (c₀=0 / skip-if-already-met /
//   commit-only-if-better — Hong 2011 §3, around Eq. 5.)
//
// ── PROJECT'S DECLARED REAL-COEFFICIENT ANALOGUE (NOT sourced — labelled
// per the cardinal honesty rule; the deviation from the complex-`c` form
// is explicit). Hong's `c` is the COMPLEX coefficient of a SINGLE
// first-order all-pass. The crestReduce search ELEMENT is the
// REAL-coefficient normalized Gray–Markel lattice (§Algorithm
// Specification Item 8) fitted by the verbatim-reused Abel & Smith band
// kernel (Item 9) + `stepDownToReflection` (Item 8 §III). So the search
// variable here is a REAL scalar `c ∈ [0, λ)` that scales the Abel &
// Smith fit's reflection-coefficient row (the search adapts the
// coefficient FEEDING that fit; it does NOT replace the fit or the
// step-down — design v2 Decision §"Per-binding-peak coefficient search").
// Consequences, each labelled:
//   * `c`, `s̃`, `p̃_c` are REAL ⇒ conjugation `(·)*` is the identity;
//     Eqs. 1/7/8/9 are evaluated with real arithmetic (the verbatim
//     structure, real-specialised). This is the project's declared
//     real-coefficient analogue of Hong's complex recurrence — labelled,
//     not presented as the verbatim complex form.
//   * The Item-7 overshoot rule re-acquires the complex `A e^{jΦ}`,
//     A,Φ ~ U[0,λ]×U[0,2π]. The project's real analogue re-acquires the
//     real magnitude A ~ U[0,λ) and keeps the trajectory's own sign (the
//     scalar only scales a signed reflection row) — i.e. `c ← A`, a
//     uniform draw of the bounded magnitude. This is the declared
//     real-coefficient analogue of the complex re-acquire.
//   * The element evaluated at scalar `c` is the time-varying normalized
//     lattice over the window (the verbatim per-sample recurrence of
//     `processLatticeChannel`, composed — its BODY is byte-unchanged and
//     reused; the streaming applicator is the Phase-2 bit-faithful
//     transcription `windowed.ts` `streamLatticeApply`). `φ'` is the
//     sensitivity of |p_c(n_i)|² to the real scalar `c` computed by the
//     verbatim Eq. 7–9 `d_i`/`g_i` recurrences specialised to the real
//     lattice section (the project's declared real analogue of Hong's
//     single-section φ'). Newton can diverge on a non-monotone objective
//     (Item 10) — the Item-7 `|c|<λ` bound + random re-acquire +
//     commit-only-if-better + bounded iteration are exactly the verbatim
//     safeguards that make the search robust without a fabricated stop.
//
// ── group-delay → λ CEILING (PROJECT GLUE ② — the *map* is the
// project's own; its constituent equations are sourced). λ (Hong's free
// 0<λ<1 stability bound, §Item 7) is set so the SUMMED cascade peak
// group delay equals the ~4–5 ms group-delay transparency ceiling, via
// Abel & Smith Eq. 4 `max_ω τ(ω) = (1+ρ)/(1−ρ)` (per-pole peak group
// delay, in SAMPLES — §Algorithm Specification Item 9) with ρ→|kₘ| by
// the RMV §III step-down (`kₘ = Aₘ(∞)`, |kₘ|<1 — Item 8). The ~4–5 ms
// ceiling is an ENTRY-ONLY NAMED BOUND (Parker–Välimäki 2013 ~4 ms
// impulse / Kahn 1962 ~5 ms patent / Schlecht 2022 ~7 ms practical —
// Items 9/3/10; Blauert–Laws 1978 / Patterson 1987 ~4–5 ms, no stored
// PDF): used as a BOUND EXPRESSED AT THE SAMPLE RATE, NOT a transcribed
// literature constant. The chosen operating value (4.0 ms) is the
// project's own QA-tuned choice WITHIN that named bound (the conservative
// Parker–Välimäki ~4 ms impulse end), labelled here as such — NOT cooked
// as a sourced constant. No literature constant is fabricated anywhere:
// the only number is the operating ceiling-in-ms (a declared
// project-glue bound), and λ falls out of Eq. 4 + the step-down ρ→|kₘ|
// relation in closed form. The 2026-05-17 keystone rework removed the
// `strength` fraction — λ is ALWAYS the full ceiling (the node always
// applies the optimal value; the Item-7 search + TP commit decide the
// realised amount, not a user dial over a non-monotone objective).

/**
 * The bounded all-pass order (= cascaded normalized-lattice sections =
 * reflection coefficients per frame). Transcribed verbatim from
 * `lattice.ts` `LATTICE_ORDER` (the section/lane count); the strength→λ
 * map's summed-cascade group-delay bound is over this many sections.
 */
import { TruePeakUpsampler } from "@e9g/buffered-audio-nodes-utils";
import { LATTICE_ORDER } from "./lattice";

/**
 * **The group-delay transparency ceiling (ms) — PROJECT GLUE ②, QA-tuned,
 * NOT sourced, NOT exposed; a NAMED BOUND used as a bound, NOT a
 * transcribed literature constant.**
 *
 * The ~4–5 ms group-delay transparency ceiling is an ENTRY-ONLY NAMED
 * BOUND in the grounding spine (Parker–Välimäki 2013 ~4 ms impulse /
 * Kahn 1962 ~5 ms patent / Schlecht 2022 ~7 ms practical — §Algorithm
 * Specification Items 9/3/10; Blauert–Laws 1978 / Patterson 1987
 * ~4–5 ms, NO stored PDF). Per the cardinal no-cooked-citations rule it
 * is used here as a BOUND EXPRESSED AT THE SAMPLE RATE (ms → samples via
 * the runtime sample rate), NOT transcribed as a sourced constant.
 *
 * 4.0 ms is the project's OWN QA-tuned operating value WITHIN that named
 * bound — the conservative Parker–Välimäki ~4 ms impulse end (a
 * transparent insert should sit at the low/safe end of the named
 * range). It is the project's declared choice (the v2 Decision
 * §"Internal calibration" classes the λ map as project glue, not
 * exposed); Phase 6 may re-tune it within the ~4–5 ms named bound. It is
 * deliberately NOT a schema field (the v2 user surface is `strength` +
 * `frameSize` + the FFT-addon paths only — λ is INTERNAL to `strength`;
 * there is NO exposed group-delay-budget knob — §Rejected Approaches
 * "Group-delay budget as a separate parameter").
 */
export const GROUP_DELAY_CEILING_MS = 4.0;

/**
 * **Deterministic per-binding-peak minimiser resolution — PROJECT GLUE,
 * QA-tuned, NOT sourced, NOT exposed.** (2026-05-17 search→CALCULATE
 * resolution; replaces the prior `MAX_SEARCH_ITERATIONS` Newton bound.)
 *
 * `searchBindingPeak` minimises the keystone objective TP4x(A_c(x)) over
 * `c ∈ [0, λ]` by a deterministic coarse uniform grid of
 * `SEARCH_GRID_POINTS` segments (⇒ +1 samples) then a deterministic
 * golden-section refine of `SEARCH_REFINE_ITERS` iterations within the
 * winning grid bracket. Both are the project's OWN declared QA-tuned
 * operating values (NOT sourced): the grid must be dense enough that its
 * step `λ/SEARCH_GRID_POINTS` does not skip the empirically-grounded
 * multimodal basins (episode-060 ≤15 interior minima over `[0, λ≈0.92]`
 * ⇒ basin spacing ≈0.06; 64 segments ⇒ step ≈0.014 ≪ 0.06). The refine
 * count fixes the achieved precision (≈ bracket·invφ^iters). Per-binding
 * cost is `SEARCH_GRID_POINTS + 2·SEARCH_REFINE_ITERS + 1` objective
 * evaluations — bounded and deterministic; Phase 6 may re-tune both
 * within the same "do not skip a basin / enough precision" contract.
 */
export const SEARCH_GRID_POINTS = 64;

/** @see {@link SEARCH_GRID_POINTS} — deterministic golden-section refine
 * iteration count within the winning grid bracket. */
export const SEARCH_REFINE_ITERS = 20;

/**
 * **The Item-7 scalable target-PAPR fraction η/|p₀|² — PROJECT GLUE,
 * QA-tuned, NOT sourced, NOT exposed.**
 *
 * Hong/Kim/Har 2011 §3 defines `η` as the *scalable target PAPR* in the
 * cost `φ(c) = |p̃_c(n_i)|² − η` (Eq. 5), with the signal power
 * normalized to `E[|p̃|²] = E[|s̃|²] = 1` — i.e. `η` is a TARGET the
 * Newton search drives the peak power DOWN to (`φ ≤ 0` ⇔ peak ≤ target);
 * the source leaves the numeric target a free, scalable design choice
 * ("scalable target PAPR"). Hong's normalization makes `η` a pure
 * target-crest figure; here it is expressed window-relative as a
 * FRACTION of the window's OWN `c₀ = 0` identity peak power:
 *
 *   η = TARGET_PEAK_POWER_RATIO · |p̃₀(n₀)|²
 *
 * so the search always ATTEMPTS to drive the window's peak below its
 * identity peak by this factor (φ(c₀) > 0 ⇒ the c₀=0 skip does NOT fire
 * on a genuinely headroom-bearing window — it fires only when the
 * window is ALREADY below the target, the true Item-7 skip case). The
 * never-worsen is NOT this target — it is per-window
 * commit-only-if-better (Item 7 + Parker–Välimäki §III-A) on the
 * ISOLATED search evaluation (identity is its floor; see
 * {@link searchBindingPeak} SCOPE CAVEAT — NOT bit-strict on the
 * rendered output, known-issue B). There is NO whole-signal never-worsen
 * (the prior `_process` veto was removed — the user-locked per-peak-only
 * model; it was never a real contract). `η` is only how AMBITIOUSLY the
 * per-window deterministic minimiser probes; it is never
 * an iteration-to-a-numeric-target (commit-if-better is the only commit
 * rule — §Rejected Approaches clearance).
 *
 * 0.5 (a 0.5 power ratio ≈ −3 dB on the window peak) is the project's OWN declared
 * QA-tuned default — the source's `η` is explicitly "scalable", with no
 * single published numeric value (the v2 Decision §"Internal
 * calibration" classes the search target as project glue, not exposed).
 * It is deliberately ambitious (ask for a real reduction; the bounded
 * |c|<λ search + commit-only-if-better deliver whatever transparent
 * fraction of it the content actually allows — the modest
 * prior-art-consistent ≈0…3.5 dB, Item 10). Phase 6 may re-tune it.
 */
export const TARGET_PEAK_POWER_RATIO = 0.5;

/**
 * The group-delay → λ ceiling (PROJECT GLUE ②). Returns the Item-7
 * stability bound λ (`0 < λ < 1`, Hong 2011 §3) — ALWAYS the full
 * psychoacoustic-group-delay ceiling (the 2026-05-17 keystone rework
 * removed the `strength` fraction: the node always applies the optimal
 * value; there is no user dial scaling λ over a provably non-monotone
 * objective).
 *
 * Derivation (Abel & Smith Eq. 4 + the RMV ρ→|kₘ| step-down — NO
 * fabricated literature constant):
 *  - A first-order all-pass section with reflection coefficient `k` has
 *    pole radius `ρ = |k|` (RMV §III: `kₘ = Aₘ(∞)`, |kₘ|<1 — Item 8) and
 *    peak group delay `max_ω τ(ω) = (1+ρ)/(1−ρ)` SAMPLES (Abel & Smith
 *    Eq. 4 with ρ→|k| — §Algorithm Specification Item 9).
 *  - The search confines the (scaled) coefficient magnitude to `|c| < λ`
 *    (Item 7). The worst-case SUMMED cascade peak group delay over the
 *    `order` sections is therefore bounded by
 *    `order · (1+λ)/(1−λ)` samples.
 *  - The ~4–5 ms ceiling EXPRESSED AT THE SAMPLE RATE is
 *    `ceilingSamples = (GROUP_DELAY_CEILING_MS/1000)·sampleRate`
 *    (a bound computed from the sample rate — NOT a transcribed
 *    constant; `GROUP_DELAY_CEILING_MS` is declared project glue within
 *    the named bound).
 *  - Setting the summed cascade peak group delay equal to that ceiling
 *    and solving for the (maximal) λ:
 *      order·(1+λ)/(1−λ) = ceilingSamples
 *      ⇒ R = ceilingSamples/order ,  (1+λ)/(1−λ) = R
 *      ⇒ λ = (R − 1)/(R + 1)               (well-defined, ∈(0,1) for R>1)
 *
 * Pure, no `this`. λ is INTERNAL (no exposed group-delay-budget knob —
 * §Rejected Approaches clearance; and no `strength` knob at all).
 *
 * @param sampleRate The runtime sample rate (Hz) — the ~4–5 ms named
 *   bound is expressed at this rate, never transcribed as a constant.
 * @param order The cascaded-lattice section count (default
 *   `LATTICE_ORDER`).
 */
export function groupDelayLambda(sampleRate: number, order: number = LATTICE_ORDER): number {
	if (order <= 0 || !(sampleRate > 0)) return 0;

	// The ~4–5 ms named bound EXPRESSED AT THE SAMPLE RATE (samples) — a
	// bound, not a transcribed constant.
	const ceilingSamples = (GROUP_DELAY_CEILING_MS / 1000) * sampleRate;
	// R = per-section group-delay budget at the cap (samples/section).
	const ratio = ceilingSamples / order;

	// R ≤ 1 would mean the ceiling is below one section's minimum delay —
	// degenerate; no transparent dispersion possible ⇒ λ = 0 (identity).
	if (!(ratio > 1)) return 0;

	// λ from Abel & Smith Eq. 4 inverted: (1+λ)/(1−λ) = R ⇒
	// λ = (R−1)/(R+1). ∈ (0,1) for R > 1 — Hong's `0 < λ < 1` holds by
	// construction (the §Rejected-Approaches "finite-order |kₘ|<λ<1
	// cannot become Schroeder phase replacement" clearance).
	return (ratio - 1) / (ratio + 1);
}

/**
 * Run the time-varying real normalized-lattice all-pass over one window,
 * with every reflection coefficient scaled by the real search scalar
 * `c`, and return the per-sample output. This is the search ELEMENT (the
 * verbatim normalized-lattice per-sample recurrence of
 * `processLatticeChannel`, composed — same Givens section, same
 * `MAX_REFLECTION` clamp; the protected kernel BODY is byte-unchanged
 * and is the live applicator via the Phase-2 bit-faithful streaming
 * transcription `windowed.ts` `streamLatticeApply`). Here it is run over
 * a single bounded window for the search's cost evaluation only —
 * coefficients are `c · row` (the search adapts the scalar feeding the
 * Abel & Smith fit; it does NOT replace the fit or the step-down).
 *
 * `reflectionRow` is the (already Abel & Smith-fitted, RMV step-down)
 * reflection-coefficient row for the window (length `order`). `c` is the
 * real search scalar (the project's real-coefficient analogue of Hong's
 * complex `c`; `|c| < λ`). Pure: fresh array; inputs unmutated.
 */
export function applyWindowAtScale(window: Float32Array, reflectionRow: Float32Array, scale: number, order: number): Float32Array {
	const length = window.length;
	const output = new Float32Array(length);
	const state = new Float32Array(order);
	// MAX_REFLECTION transcribed verbatim from lattice.ts (module-private
	// there); the windowed evaluation must clamp identically to the live
	// applicator so the search cost matches the produced signal.
	const MAX_REFLECTION = 0.95;

	for (let sample = 0; sample < length; sample++) {
		let signalValue = window[sample] ?? 0;

		for (let section = 0; section < order; section++) {
			let kCoeff = scale * (reflectionRow[section] ?? 0);

			if (kCoeff > MAX_REFLECTION) kCoeff = MAX_REFLECTION;
			else if (kCoeff < -MAX_REFLECTION) kCoeff = -MAX_REFLECTION;

			const cCoeff = Math.sqrt(Math.max(0, 1 - kCoeff * kCoeff));
			const delayed = state[section] ?? 0;
			// Orthogonal first-order normalized all-pass section (RMV Fig.
			// 4(b)) — energy-preserving every sample (Item 8 part (b)).
			const toDelay = cCoeff * signalValue + kCoeff * delayed; // → next sₘ
			const sectionOut = -kCoeff * signalValue + cCoeff * delayed; // → xₘ₊₁

			state[section] = toDelay;
			signalValue = sectionOut;
		}

		output[sample] = signalValue;
	}

	return output;
}


/**
 * The per-channel **4× true-peak POWER across channels** (linear, `|x|²`)
 * of one window applied at scalar `scale` — the 2026-05-17 keystone
 * Item-7 objective. For each channel the candidate window
 * `applyWindowAtScale(window, reflectionRow, scale, order)` is run
 * through a FRESH cold BS.1770-4 Annex 1 4× `TruePeakUpsampler` (one per
 * channel) and the cross-channel max |upsampled| is taken; the returned
 * value is its SQUARE (a power, matching Hong's `|p̃(n_i)|²` cost shape).
 *
 * A FRESH cold upsampler per channel per call is MANDATORY (same
 * discipline as `objective.ts` `measureFrameTruePeakDb`): many candidate
 * scales are probed, the upsampler's 12-tap history would otherwise let
 * one candidate's tail lift the next candidate's measured peak and its
 * running state would never report a lower peak for a better candidate.
 * The first 11 oversampled outputs are coloured by the cold history
 * (zeros) — harmless for a max (they are ≤ the settled peak).
 *
 * Pure (constructs/discards local upsamplers); no `this`. Returns 0 for
 * empty input.
 */
export function truePeakPower4x(channelWindows: ReadonlyArray<Float32Array>, reflectionRow: Float32Array, scale: number, order: number): number {
	let maxAbs = 0;

	for (const channelWindow of channelWindows) {
		if (channelWindow.length === 0) continue;

		const transformed = applyWindowAtScale(channelWindow, reflectionRow, scale, order);
		// FRESH cold 4× upsampler per channel per candidate (the mandatory
		// no-history discipline — see this function's JSDoc).
		const upsampler = new TruePeakUpsampler(4);
		const upsampled = upsampler.upsample(transformed);

		for (let index = 0; index < upsampled.length; index++) {
			const value = upsampled[index] ?? 0;
			const magnitude = value < 0 ? -value : value;

			if (magnitude > maxAbs) maxAbs = magnitude;
		}
	}

	// |truePeak|² — a POWER, matching Hong's Eq. 5 `|p̃(n_i)|²` cost shape
	// (φ ≤ 0 ⇔ true-peak power ≤ η). The square keeps η as a power ratio.
	return maxAbs * maxAbs;
}

/** The result of a per-binding-peak Item-7 search over one window. */
export interface SearchResult {
	/**
	 * The committed real search scalar `c` (the project's
	 * real-coefficient analogue of Hong's coefficient; `|c| < λ`). The
	 * caller scales the window's reflection row by this. `0` ⇒ identity
	 * was committed (the floor of the ISOLATED search evaluation — Item 7
	 * commit-only-if-better; see {@link searchBindingPeak} SCOPE CAVEAT:
	 * NOT a bit-strict guarantee on the rendered output — known-issue B).
	 */
	readonly scale: number;
	/** Total objective evaluations the deterministic minimiser ran
	 * (`1 + SEARCH_GRID_POINTS + 2·SEARCH_REFINE_ITERS` at most; `1` for
	 * the skip-if-already-met case). Deterministic — not a Newton count. */
	readonly iterations: number;
	/**
	 * Cross-channel **4× true-peak POWER** (linear, `|truePeak|²`) at the
	 * committed scale (the 2026-05-17 keystone Item-7 objective —
	 * {@link truePeakPower4x}, NOT the raw window sample peak).
	 */
	readonly committedPeakPower: number;
	/**
	 * Cross-channel 4× true-peak power (linear, `|truePeak|²`) of the
	 * untransformed window (`c=0`) — the never-worsen floor.
	 */
	readonly identityPeakPower: number;
	/** `true` iff `c₀=0` already met the target (the Item-7 skip case). */
	readonly skippedAlreadyMet: boolean;
}

/**
 * The per-binding-peak optimal-decorrelation-amount minimiser over one
 * analysis window. **2026-05-17 search→CALCULATE resolution** (user-
 * directed; recorded for the Phase-7 design write-back): the prior Item-7
 * Newton-Raphson + `Math.random` re-acquire (Hong/Kim/Har 2011 §3) is
 * REPLACED by a DETERMINISTIC bounded 1-D minimisation. Crest reduction
 * is NON-MONOTONE in `c` (Item 10, Schlecht 2022 Eq. 2) and was
 * empirically confirmed MULTIMODAL on real content (episode-060: 6–15
 * interior minima per window) — so there is NO closed-form optimum; but
 * `c` lives on a BOUNDED interval, so the optimum is COMPUTED
 * deterministically (dense grid + golden-section refine) rather than
 * stochastically searched. The objective / η / commit-only-if-better
 * lineage (Hong 2011 §3 cost shape, Parker–Välimäki §III-A never-worsen)
 * is UNCHANGED; only the *iteration mechanism* changed (no Newton, no φ′,
 * no RNG). On real content this beats the prior random Newton by
 * ~0.5–1.8 dB and removes 0–1.8 dB of run-to-run nondeterminism.
 *
 * The element is the normalized lattice (Item 8) fitted by the
 * verbatim-reused Abel & Smith band kernel (Item 9) + `stepDownToReflection`
 * (Item 8 §III) — passed in as `reflectionRow`. The minimiser adapts the
 * real scalar `c` FEEDING that fit; it does NOT replace the fit or the
 * step-down.
 *
 * Mechanism:
 *  - `c=0` (identity) is the never-worsen FLOOR; its cross-channel 4×
 *    true-peak power `TP4x(A_0(x))²` is measured first. If it already
 *    meets the scaled target η (or λ ≤ 0) the result is identity
 *    (`skippedAlreadyMet`) — deterministic skip, no RNG.
 *  - objective `TP4x(A_c(x))²` = cross-channel **4× true-peak POWER**
 *    ({@link truePeakPower4x}), NOT the raw window sample peak (the
 *    keystone correction: the raw sample peak is blind to the
 *    inter-sample overshoot that determines the file's true peak).
 *  - DETERMINISTIC minimisation over `c ∈ [0, λ]` NON-NEGATIVE: a coarse
 *    uniform grid of {@link SEARCH_GRID_POINTS} segments then a
 *    {@link SEARCH_REFINE_ITERS}-iteration golden-section refine within
 *    the winning grid bracket. Domain is `[0, λ]` (not `(−λ, λ)`):
 *    downstream (`trajectory.ts`) requires a NON-NEGATIVE decorrelation
 *    amount; the prior Newton could silently commit negative `c` — a
 *    latent bug this domain fixes.
 *  - COMMIT-ONLY-IF-BETTER is intrinsic: grid sample 0 is exactly `c=0`,
 *    so the committed `c` has the LOWEST 4× true-peak power seen incl.
 *    identity ⇒ the result never raises the window's 4× true peak above
 *    identity **as evaluated HERE** (Parker–Välimäki §III-A read
 *    per-window, Item 10). SCOPE CAVEAT (known-issue B, measured — NOT a
 *    hard production guarantee): this evaluation is the ISOLATED window
 *    with ZERO initial lattice state and a CONSTANT `c`; production
 *    (`streamLatticeApply`) is a CONTINUOUS recursive lattice carrying
 *    section state across the whole signal with the row frame-
 *    interpolated, so the REALISED per-window 4× TP can marginally exceed
 *    identity (episode-060: ≈5% of binding windows, mean ≈+0.22 dB, p90
 *    ≈+0.63 dB). The never-worsen holds for THIS isolated model, not
 *    bit-strictly for the rendered output (the warm-state/exact-hold-span
 *    faithful-evaluation fix for B is recorded for Phase 7; the
 *    conservative gate accepted at 0.07%/+1.1 dB bounds its impact).
 *
 * η (the scalable target) is WINDOW-RELATIVE: `targetPeakRatio ·
 * TP4x(c=0)²` (a fraction of the window's OWN identity power). It only
 * gates the deterministic skip-if-already-met; the HARD never-worsen
 * guarantee is commit-only-if-better (identity is the floor).
 *
 * Fully DETERMINISTIC and pure (constructs/discards fresh cold upsamplers
 * per candidate; no RNG anywhere); no `this`. Same inputs ⇒ identical
 * result, run to run.
 *
 * @param channelWindows The binding window's PER-CHANNEL samples (one
 *   `Float32Array` per channel — the commit objective is the
 *   cross-channel 4× true peak; for mono pass a single-element array).
 * @param reflectionRow The Abel & Smith-fitted + RMV step-down
 *   reflection row for this window (length `order`).
 * @param order The cascaded-lattice section count.
 * @param lambda The stability bound `λ ∈ (0,1)` (from
 *   {@link groupDelayLambda}); the minimisation domain is `[0, λ]`.
 * @param targetPeakRatio η/TP4x(c=0)² — the scalable target fraction of
 *   the window's own identity 4× true-peak power (PROJECT GLUE; defaults
 *   to {@link TARGET_PEAK_POWER_RATIO}); gates only the deterministic
 *   skip-if-already-met.
 */
export function searchBindingPeak(
	channelWindows: ReadonlyArray<Float32Array>,
	reflectionRow: Float32Array,
	order: number,
	lambda: number,
	targetPeakRatio: number = TARGET_PEAK_POWER_RATIO,
): SearchResult {
	// c₀ = 0 (Hong 2011 §3 verbatim) — the identity all-pass over the
	// window. Its cross-channel 4× true-peak POWER is the guaranteed
	// never-worsen FLOOR (the keystone Item-7 objective).
	const identityPower = truePeakPower4x(channelWindows, reflectionRow, 0, order);
	// η (Hong2011 Eq. 5 scalable target) window-relative: a fraction of
	// the window's OWN identity 4× true-peak power (so the search ATTEMPTS
	// a real reduction; commit-only-if-better is the never-worsen floor).
	const targetPeakPower = Math.max(0, targetPeakRatio) * identityPower;

	// "The c_0 is set to zero and then the PAPR is checked whether it
	// satisfies the target PAPR. If so, [the update] is skipped" — Item 7
	// skip-if-already-met (φ(c₀) ≤ 0 ⇒ TP4x² ≤ η). With a window-relative
	// η < TP4x(c₀=0)² this fires only when identity ALREADY meets the
	// scaled target (e.g. a near-silent window) — the true Item-7 skip.
	if (identityPower <= targetPeakPower || lambda <= 0) {
		return {
			scale: 0,
			// One objective evaluation was performed (the identity / c=0
			// `truePeakPower4x` above) — `iterations` is the deterministic
			// evaluation count, so the skip path is 1, not 0.
			iterations: 1,
			committedPeakPower: identityPower,
			identityPeakPower: identityPower,
			skippedAlreadyMet: true,
		};
	}

	// ── DETERMINISTIC bounded 1-D minimisation of the keystone objective
	// TP4x(A_c(x)) over c ∈ [0, λ] — the 2026-05-17 search→CALCULATE
	// resolution (replaces the prior Item-7 Newton + `Math.random`
	// re-acquire). The objective is MULTIMODAL in `c` (episode-060: 6–15
	// interior minima per real window — empirically grounded by the
	// c-objective feasibility study; recorded for the Phase-7 design
	// write-back), so there is NO closed form; but `c` lives on a BOUNDED
	// interval, so a deterministic dense grid + deterministic
	// golden-section refine COMPUTES the optimum reproducibly (no RNG, no
	// Newton/φ′, no re-acquire) — and on real content it beats the prior
	// random Newton by ~0.5–1.8 dB while removing the 0–1.8 dB run-to-run
	// nondeterminism. Domain is [0, λ] NON-NEGATIVE: the whole downstream
	// envelope architecture (`trajectory.ts` `amountEnv ≥ 0`, the
	// `max(exactHeld, iirSpill)` model, the gate-to-0) requires a
	// non-negative decorrelation amount; a negative `c` is a sign-flipped
	// (different) all-pass that violates that invariant (the prior Newton
	// could and did silently commit negative `c` — a latent bug this
	// bounded non-negative domain also fixes). Grid sample 0 is exactly
	// c=0 (identity, `identityPower` above), so `bestPeak` starts at the
	// floor and can only improve — commit-only-if-better is intrinsic
	// (Parker–Välimäki §III-A read per-window) for THIS isolated
	// evaluation; NOT bit-strict on the rendered output — see the JSDoc
	// SCOPE CAVEAT / known-issue B.
	let bestScale = 0;
	let bestPeak = identityPower;
	// Total objective evaluations (the identity above counts as 1).
	// Reported as `iterations` for the unchanged `SearchResult` shape —
	// now a deterministic evaluation count, not a Newton iteration count.
	let evaluations = 1;

	const evalAt = (candidate: number): number => {
		evaluations += 1;

		return truePeakPower4x(channelWindows, reflectionRow, candidate, order);
	};

	// Coarse uniform grid over [0, λ] (inclusive): SEARCH_GRID_POINTS
	// segments ⇒ SEARCH_GRID_POINTS+1 samples. The step
	// λ/SEARCH_GRID_POINTS is well below the empirical multimodal basin
	// spacing (episode-060 ≤15 minima over [0, λ≈0.92] ⇒ basin spacing
	// ≈0.06), so the grid does not skip the global basin. Sample
	// gridIndex=0 is c=0 (identity) — already measured as
	// `identityPower`; skip it.
	for (let gridIndex = 1; gridIndex <= SEARCH_GRID_POINTS; gridIndex++) {
		const candidate = (lambda * gridIndex) / SEARCH_GRID_POINTS;
		const power = evalAt(candidate);

		if (power < bestPeak) {
			bestPeak = power;
			bestScale = candidate;
		}
	}

	// Deterministic golden-section refine within the bracket
	// [bestScale − step, bestScale + step] (clamped to [0, λ]) — the
	// uniform grid makes `bestScale` a grid node, so this bracket spans
	// its two grid neighbours, i.e. the grid-global basin. Fixed iteration
	// count ⇒ fully deterministic; no RNG, no convergence-dependent stop.
	const step = lambda / SEARCH_GRID_POINTS;
	let lo = Math.max(0, bestScale - step);
	let hi = Math.min(lambda, bestScale + step);

	if (hi > lo) {
		const invPhi = (Math.sqrt(5) - 1) / 2; // 1/φ ≈ 0.6180339887
		let x1 = hi - invPhi * (hi - lo);
		let x2 = lo + invPhi * (hi - lo);
		let f1 = evalAt(x1);
		let f2 = evalAt(x2);

		for (let iter = 0; iter < SEARCH_REFINE_ITERS; iter++) {
			if (f1 <= f2) {
				hi = x2;
				x2 = x1;
				f2 = f1;
				x1 = hi - invPhi * (hi - lo);
				f1 = evalAt(x1);
			} else {
				lo = x1;
				x1 = x2;
				f1 = f2;
				x2 = lo + invPhi * (hi - lo);
				f2 = evalAt(x2);
			}
		}

		const refinedScale = f1 <= f2 ? x1 : x2;
		const refinedPower = Math.min(f1, f2);

		if (refinedPower < bestPeak) {
			bestPeak = refinedPower;
			bestScale = refinedScale;
		}
	}

	return {
		scale: bestScale,
		iterations: evaluations,
		committedPeakPower: bestPeak,
		identityPeakPower: identityPower,
		skippedAlreadyMet: false,
	};
}
