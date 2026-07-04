// crestReduce realization core — the normalized (Gray–Markel) LOSSLESS
// LATTICE all-pass, whole-file (post-2026-05-16 FUNDAMENTAL REFRAME: the
// SINGLE v1 realization; `spectral` and the `realization` parameter are
// removed).
//
// Algorithm source (read in full, verbatim-transcribed): normalized
// Gray–Markel lossless lattice all-pass — Gray & Markel (1973) [IEEE Trans.
// AU-21:491–500] / Gray & Markel (1975) [IEEE Trans. ASSP-23:268–270], as
// reproduced verbatim in Regalia, Mitra & Vaidyanathan (1988), *Proc. IEEE*
// 76(1):19–37, DOI 10.1109/5.3286, §II/§III/§IX — see
// design-crest-reduce.md §Algorithm Specification item 8. Specifically:
//   - the all-pass / mirror-image form A(z) = z⁻ᴹ D(z⁻¹)/D(z) (RMV §II
//     Eq. 2.3) — a real all-pass is fully determined by its denominator
//     D(z);
//   - the D(z) → reflection-coefficient kₘ step-down (RMV §III Eq.
//     3.3a/3.3b, kₘ = Aₘ(∞); the classical Levinson/step-down recursion in
//     all-pass form) — item 8 part (c).2, the load-bearing sourced half;
//   - each section realized as the NORMALIZED two-pair = a Givens rotation
//     with multipliers [ √(1−kₘ²)  kₘ ; −kₘ  √(1−kₘ²) ] and a z⁻¹ on the
//     recirculating branch (RMV §III Fig. 4(b), refs [13]/[14]) — item 8
//     part (a.1);
//   - the per-section orthogonal map is INSTANTANEOUSLY energy-balanced
//     (RMV §IX Eq. 9.8 RᵗR = I ⇒ Eq. 9.10 yᵀy + Δ‖x‖² = uᵀu), so the
//     structure stays lossless even under TIME-VARYING kₘ (item 8 part
//     (b)) — the documented fix for the Phase-4 Direct-Form-I defect
//     (which had no per-sample energy-balance structure and injected
//     energy at every coefficient change; design-crest-reduce.md §Rejected
//     Approaches).
//
// The target-phase → D(z) front half (item 8 part (c).1) is the GROUNDED
// Abel & Smith (2006) DAFx-06 §3 closed-form target-group-delay →
// cascaded-biquad design (§Algorithm Specification item 9), implemented in
// `utils/dispersion.ts` (Eq. 7–12 verbatim). It REPLACES the earlier
// heuristic per-frame pole-grid search (Phase 5F.1, 2026-05-16 FUNDAMENTAL
// REFRAME). Low order ⇒ BOUNDED group delay — the bounded-transparent
// realization. The only project-glue residue is (a) the peak-prioritised
// Schroeder-phase → δ(ω) mapping and (b) the per-band β schedule, both
// explicitly labelled the project's own design choice in `dispersion.ts`
// (NOT sourced — Abel & Smith leave β user-supplied).
//
// This module is the BYTE-FROZEN verbatim Gray–Markel/RMV reference. The
// live production path no longer calls it: the 2026-05-17 keystone
// streams the equivalent math through the bit-faithful transcriptions in
// `utils/windowed.ts` (`streamLatticeTrajectory` / `LatticeApplyState`,
// FP-identical to `extractLatticeTrajectory` / `processLatticeChannel`
// over one contiguous array; `LatticeApplyState` applies the recurrence
// per emitted chunk in `_unbuffer`, carrying state + the absolute sample
// index across chunks). `extractLatticeTrajectory` (whole-file
// framed analysis → per-frame reflection-coefficient CONTROL TRAJECTORY +
// transient mask) and `processLatticeChannel` (the time-varying
// normalized-lattice per-sample recurrence) remain here as the protected
// golden reference the streaming transcriptions are byte-faithful to —
// exercised by `lattice.unit.test.ts` (losslessness / topology).
//
// The stream (index.ts + utils/trajectory.ts) owns whole-file
// accumulation and the trajectory smoothing. There is NO whole-signal
// never-worsen and NO `strength` parameter / `strength=0` bypass — both
// were removed by the 2026-05-17 keystone (the only never-worsen is the
// per-window commit-only-if-better inside the deterministic Item-7
// minimiser).

import { stft, type FftBackend, type StftResult } from "@buffered-audio/utils";
import { designDispersionAllpass, schroederTargetToDelay } from "./dispersion";
import type { ControlTrajectory } from "./trajectory";

/**
 * All-pass order M = number of cascaded lattice sections = reflection
 * coefficients per frame (the control-trajectory lane count). LOW ORDER by
 * design: bounded group delay = the bounded-transparent realization
 * (design-crest-reduce.md §Current Design "`cascade` — a LOW-ORDER
 * Schroeder-targeted all-pass … bounded transparency"; §Algorithm
 * Specification item 8 part (c) "Low order ⇒ bounded group delay"). 8
 * second-order-equivalent sections span the band with a few-ms worst-case
 * group delay at 48 kHz, well under the Blauert-Laws audibility threshold
 * the design calibrates the group-delay ceiling (the Item-7 λ bound)
 * against.
 */
export const LATTICE_ORDER = 8;

/**
 * A transient is flagged at frame `f` when its windowed energy exceeds the
 * previous frame's by more than this ratio (a sharp inter-frame rise = an
 * onset). Drives the trajectory smoothing-law asymmetry (the smoothed
 * reflection-coefficient trajectory rides through onsets near identity
 * rather than chasing the moving per-frame fit across the discontinuity).
 * (`utils/trajectory.ts`; single realization — 2026-05-16 FUNDAMENTAL
 * REFRAME).
 */
const TRANSIENT_ENERGY_RATIO = 2.0;

/**
 * Maximum magnitude any single reflection coefficient is allowed to take.
 * RMV §III guarantees `|kₘ| < 1` for a stable all-pass; clamping strictly
 * inside the unit circle keeps `√(1−kₘ²)` real and bounded away from 0
 * (numerical stability of the Givens section under the smoothed
 * time-varying trajectory). 0.95 leaves ample dispersion range while
 * keeping every section well-conditioned.
 */
const MAX_REFLECTION = 0.95;

export interface LatticeAnalysis {
	/** Per-frame reflection-coefficient control trajectory (lane = section). */
	readonly trajectory: ControlTrajectory;
	/** The whole signal, per channel (the lattice runs over this directly). */
	readonly channelSignals: ReadonlyArray<Float32Array>;
	readonly frameCount: number;
	readonly order: number;
	readonly hopSize: number;
	readonly signalLength: number;
}

/**
 * Step-down / Levinson recursion in all-pass form: extract the reflection
 * coefficients `k_1..k_M` from a real all-pass `A_M(z) = z⁻ᴹ D(z⁻¹)/D(z)`
 * given its denominator polynomial `D(z) = 1 + d_1 z⁻¹ + … + d_M z⁻ᴹ`
 * (`denominator[0] === 1`).
 *
 * Verbatim per RMV 1988 §III Eq. 3.3a/3.3b (design-crest-reduce.md
 * §Algorithm Specification item 8 part (c).2): `kₘ = Aₘ(∞)` is the
 * highest-order tap of the order-`m` denominator (the constant term of the
 * numerator = the reversed leading denominator coefficient), and
 * `z⁻¹A_{m-1}(z) = (Aₘ(z) − kₘ)/(1 − kₘAₘ(z))` reduces the order by one.
 * In polynomial terms, with `a^{(m)}` the order-`m` denominator coeffs
 * (`a^{(m)}_0 = 1`):
 *
 *   kₘ = a^{(m)}_m
 *   a^{(m-1)}_i = (a^{(m)}_i − kₘ · a^{(m)}_{m-i}) / (1 − kₘ²),  i = 0..m-1
 *
 * for `m = M, M-1, …, 1` (the classical Levinson step-down; RMV proves
 * `|kₘ| < 1` at each step for a stable `A(z)`). Returns `k_1..k_M` (index
 * 0 = section 1). If a step is ill-conditioned (`|kₘ| → 1`) the
 * coefficient is clamped to `MAX_REFLECTION` and the recursion continues
 * with the clamped value (keeps `√(1−kₘ²)` real for the Givens section).
 *
 * Pure: does not mutate `denominator`.
 */
export function stepDownToReflection(denominator: ReadonlyArray<number> | Float32Array): Float32Array {
	const order = denominator.length - 1;
	const reflection = new Float32Array(Math.max(0, order));

	if (order <= 0) return reflection;

	// `current` is a^{(m)} for the current order m, normalized so a_0 = 1.
	let current = Array.from(denominator, (value) => value);
	const lead = current[0] ?? 1;

	if (lead !== 0 && lead !== 1) current = current.map((value) => value / lead);

	for (let mOrder = order; mOrder >= 1; mOrder--) {
		let km = current[mOrder] ?? 0;

		if (!Number.isFinite(km)) km = 0;

		km = Math.max(-MAX_REFLECTION, Math.min(MAX_REFLECTION, km));
		reflection[mOrder - 1] = km;

		const denom = 1 - km * km;
		const next = new Array<number>(mOrder).fill(0);

		// a^{(m-1)}_i = (a^{(m)}_i − kₘ a^{(m)}_{m-i}) / (1 − kₘ²)
		for (let index = 0; index < mOrder; index++) {
			next[index] = ((current[index] ?? 0) - km * (current[mOrder - index] ?? 0)) / denom;
		}

		next[0] = 1; // structurally exact (a_0 ≡ 1); avoid FP drift
		current = next;
	}

	return reflection;
}

/**
 * Per-frame peak-priority dispersion AMOUNT in `[0, 1]` — the
 * peak-prioritised windowed targeting (5R.1, carried forward; the
 * `loudnessTarget`-windowed-max-envelope analogue). NOT the all-pass fit
 * itself (the grounded Abel & Smith design in utils/dispersion.ts is the
 * fit); this scales the desired group delay δ(ω) so the effect
 * concentrates where coincident peaks exist and stays ≈identity on
 * already-diffuse / already-limited material (a principled targeting
 * outcome — design §Current Design / keystone FUNDAMENTAL REFRAME
 * "Targeting").
 *
 * The local crest factor (windowed peak / windowed RMS) of the channel
 * sum over the analysis window is the headroom proxy: a high peak-to-RMS
 * ratio = coincident-peak headroom a phase-only transform can recover; a
 * low ratio (already-diffuse / already-limited) = no headroom, map toward
 * 0 (≈identity). The crest factor is mapped through a smooth saturating
 * ramp from `CREST_FLOOR` (≈ a single sine's √2 crest — nothing to gain)
 * to `CREST_CEIL` (strongly peaky). Conventional engineering with an
 * in-codebase precedent (`loudnessTarget`'s windowed envelope); the
 * keystone FUNDAMENTAL REFRAME "Amends / supersedes" states the
 * peak-prioritised windowed targeting is a new design element,
 * conventional engineering, no external grounding required — but it is
 * still the PROJECT'S OWN design choice, declared here, not sourced.
 *
 * @param signal The channel-sum signal.
 * @param windowStart First sample of the analysis window (frame start).
 * @param windowLen Window length (= the analysis frame size).
 *
 * Exported (Phase 2.2, plan-crest-reduce-envelope-v2.md) so the node-local
 * streaming trajectory driver (`utils/windowed.ts`) can reuse this
 * per-frame glue VERBATIM (body unchanged — only the `export` keyword
 * added). It is orchestrator glue, NOT one of the verbatim-protected
 * kernels; reusing it bit-for-bit keeps the streamed trajectory
 * FP-identical to the as-built `extractLatticeTrajectory`.
 */
export function peakPriorityAmount(signal: Float32Array, windowStart: number, windowLen: number): number {
	const end = Math.min(signal.length, windowStart + windowLen);
	let peak = 0;
	let sumSquares = 0;
	let count = 0;

	for (let sample = Math.max(0, windowStart); sample < end; sample++) {
		const value = signal[sample] ?? 0;
		const absolute = value < 0 ? -value : value;

		if (absolute > peak) peak = absolute;

		sumSquares += value * value;
		count += 1;
	}

	if (count === 0 || peak <= 0) return 0;

	const rms = Math.sqrt(sumSquares / count);

	if (rms <= 0) return 0;

	const crest = peak / rms;
	// √2 ≈ 1.414 is a single sine's crest (no headroom for a phase-only
	// transform); 6 is a strongly peaky frame. Smoothstep between them.
	const CREST_FLOOR = Math.SQRT2;
	const CREST_CEIL = 6;
	const tNorm = Math.max(0, Math.min(1, (crest - CREST_FLOOR) / (CREST_CEIL - CREST_FLOOR)));

	return tNorm * tNorm * (3 - 2 * tNorm);
}

/**
 * Whole-file analysis: frame the channel sum (Hann-windowed STFT), and
 * per frame run the GROUNDED Abel & Smith (2006) DAFx-06 §3 closed-form
 * target-group-delay → cascaded-biquad all-pass design (§Algorithm
 * Specification item 9, `utils/dispersion.ts`):
 *
 *   1. peak-prioritised Schroeder-derived target phase (the project's
 *      §Algorithm Specification item 1 target, `schroeder.ts`, reused
 *      UNMODIFIED) → differentiate to the desired group delay δ(ω),
 *      scaled by the peak-priority windowed AMOUNT (5R.1 windowed
 *      targeting carried forward) — this peak-prioritised Schroeder →
 *      δ(ω) mapping is the PROJECT'S OWN design choice glue (a), labelled
 *      as such in `dispersion.ts`, NOT sourced;
 *   2. Abel & Smith band-segmentation (Eq. 7–12 verbatim) → the
 *      cascaded-biquad real denominator `D(z)` (the per-band β schedule
 *      is the PROJECT'S OWN design choice glue (b), labelled in
 *      `dispersion.ts`, NOT sourced — Abel & Smith leave β
 *      user-supplied);
 *   3. `stepDownToReflection(D(z))` → the section reflection coefficients
 *      `kₘ` via the RMV-1988 §III Eq. 3.3a/3.3b step-down (item 8 part
 *      (c).2, verbatim-sourced, unchanged) — RMV guarantees `|kₘ| < 1` at
 *      every step for a stable `D(z)` (the clamp is the numerical
 *      tightening only).
 *
 * The fixed-length (`LATTICE_ORDER`) reflection row is zero-padded when
 * the Abel & Smith partition lands fewer than `LATTICE_ORDER` sections (a
 * `kₘ = 0` trailing section is a pure unit delay — the identity-section
 * contribution to the bounded bulk group delay, see `processLatticeChannel`
 * / the lattice identity contract). Emits the per-frame
 * reflection-coefficient CONTROL TRAJECTORY (linked stereo — one
 * coefficient set from the channel sum, later run over every channel's own
 * signal) plus a per-frame transient mask. Pure: fresh outputs; mutates no
 * input.
 *
 * The whole-file STFT here is analysis-only (per-frame magnitude → fit);
 * synthesis is the time-domain recursive normalized lattice, NOT OLA — so
 * the Schroeder-period-vs-short-frame STFT/OLA failure mode that defeated
 * the rejected `spectral` path (plan §5R.2; design §Rejected Approaches)
 * structurally cannot occur here.
 */
export function extractLatticeTrajectory(
	channelSignals: ReadonlyArray<Float32Array>,
	sumSignal: Float32Array,
	frameSize: number,
	hopSize: number,
	backend?: FftBackend,
	addonOptions?: { vkfftPath?: string; fftwPath?: string },
): LatticeAnalysis {
	const halfSize = frameSize / 2 + 1;
	const order = LATTICE_ORDER;
	const sumStft: StftResult = stft(sumSignal, frameSize, hopSize, undefined, backend, addonOptions);
	const frameCount = sumStft.frames;
	const signalLength = sumSignal.length;

	const rows: Array<Float32Array> = new Array<Float32Array>(frameCount);
	const identity = new Float32Array(order); // all-zero kₘ = the trivial all-pass
	const transientMask = new Float32Array(frameCount);
	const sumMagnitude = new Float32Array(halfSize);
	let previousEnergy = 0;

	for (let frame = 0; frame < frameCount; frame++) {
		const base = frame * halfSize;
		let energy = 0;

		for (let bin = 0; bin < halfSize; bin++) {
			const re = sumStft.real[base + bin] ?? 0;
			const im = sumStft.imag[base + bin] ?? 0;
			const mag = Math.hypot(re, im);

			sumMagnitude[bin] = mag;
			energy += mag * mag;
		}

		transientMask[frame] = previousEnergy > 0 && energy > TRANSIENT_ENERGY_RATIO * previousEnergy ? 1 : 0;
		previousEnergy = energy;

		// Grounded Abel & Smith (2006) §3 closed-form fit (item 9). The
		// peak-prioritised Schroeder target phase is differentiated to the
		// desired group delay δ(ω), scaled by the windowed peak-priority
		// AMOUNT (5R.1 windowed targeting): a diffuse / already-limited
		// frame → amount ≈ 0 → δ ≈ 0 → an identity all-pass (the
		// principled ≈identity targeting outcome). The Abel & Smith
		// band-segmentation (Eq. 7–12 verbatim, dispersion.ts) yields the
		// cascaded-biquad real `D(z)`; `stepDownToReflection` is the
		// verbatim-sourced RMV §III Eq. 3.3 D(z)→kₘ map (item 8 part
		// (c).2). The (a) Schroeder→δ(ω) mapping and (b) the per-band β
		// schedule are the PROJECT'S OWN design choice, labelled as such
		// in dispersion.ts (NOT sourced).
		const amount = peakPriorityAmount(sumSignal, frame * hopSize, frameSize);
		const delay = schroederTargetToDelay(sumMagnitude, amount);
		const { denominator } = designDispersionAllpass(delay, order);
		const reflection = stepDownToReflection(denominator);
		const row = new Float32Array(order);

		for (let section = 0; section < order; section++) row[section] = reflection[section] ?? 0;

		rows[frame] = row;
	}

	return {
		trajectory: { rows, laneCount: order, identity, transientMask },
		channelSignals,
		frameCount,
		order,
		hopSize,
		signalLength,
	};
}

/**
 * Process one channel's whole signal through a CASCADE of `M` NORMALIZED
 * first-order all-pass sections with TIME-VARYING reflection coefficients,
 * linearly interpolated between analysis frames to the sample rate. This
 * is the normalized cascaded lattice of RMV §III Fig. 3 built from
 * first-order normalized two-pairs (RMV Fig. 4(b); design item 8 a.1):
 * "an arbitrary stable all-pass function can be realized using the
 * normalized cascaded lattice … an energy balanced structure" (RMV §IX).
 *
 * Each section is ONE orthogonal Givens rotation + ONE z⁻¹ state `sₘ`,
 * with `cₘ = √(1 − kₘ²)`:
 *
 *     aₘ =  cₘ·xₘ + kₘ·sₘ           (a is delayed → next sample's sₘ)
 *     yₘ = −kₘ·xₘ + cₘ·sₘ           (y is the section output → xₘ₊₁)
 *
 * The 2×2 map `[aₘ; yₘ] = [cₘ kₘ; −kₘ cₘ]·[xₘ; sₘ]` is orthogonal, so
 * `aₘ² + yₘ² = xₘ² + sₘ²` EXACTLY every sample for ANY `kₘ` — RMV §IX
 * Eq. 9.8 `RᵗR = I` ⇒ Eq. 9.10 `y² + Δ‖state‖² = u²`. This per-sample
 * structural energy balance holds even under TIME-VARYING `kₘ` (item 8
 * part (b)) — the documented fix for the Phase-4 Direct-Form-I defect
 * (Direct-Form had no per-sample energy-balance structure and injected
 * energy at every coefficient change; design §Rejected Approaches).
 * Algebraically each section realizes the exact first-order all-pass
 * `(−kₘ + z⁻¹)/(1 − kₘ z⁻¹)` (substitute `sₘ = z⁻¹ aₘ`); cascading `M`
 * sections realizes the order-`M` all-pass formed from the fitted `D(z)`.
 *
 * The `strength` parameter is the verbatim post-fit scalar `kₘ ←
 * strength · smoothedₘ`. It is an INTERNAL argument of this byte-frozen
 * reference (and of its bit-faithful transcription `LatticeApplyState`),
 * NOT a public surface: the 2026-05-17 keystone removed the `strength`
 * user parameter entirely (the per-peak optimal decorrelation amount is
 * folded into the committed trajectory rows by the Item-7 minimiser);
 * every caller passes the literal `1`, an exact identity no-op
 * (`1 · smoothedₘ = smoothedₘ`) that keeps this recurrence verbatim.
 *
 * ── LATTICE IDENTITY CONTRACT (the HONEST property — 5F.2). At
 * `kₘ = 0` a section computes `aₘ = cₘ·xₘ + kₘ·sₘ = 1·xₘ = xₘ` (→ next
 * sample's `sₘ`) and `yₘ = −kₘ·xₘ + cₘ·sₘ = 1·sₘ = sₘ` (the section
 * output = its PREVIOUS state). So a `kₘ = 0` first-order normalized
 * section is **exactly `z⁻¹`** — a one-sample delay, NOT a unity
 * passthrough. An all-`kₘ = 0` (identity-trajectory) cascade of `M = order`
 * such sections is therefore **exactly `z⁻ᴹ`: the input delayed by
 * exactly `M` samples**, NOT a sample-for-sample passthrough. A pure
 * integer `M`-sample delay is an all-pass — it changes neither the 4×
 * true peak nor the RMS (both shift-invariant), so it is **crest-
 * invariant** and fully correct for this node's contract. This is the
 * lattice's own identity outcome; it is honestly an `M`-sample-delayed
 * (crest-invariant) passthrough, NOT sample-exact.
 *
 * There is NO node-level bypass: the 2026-05-17 keystone removed the
 * `strength` user parameter and its `strength === 0` early-return — the
 * node always runs the gate/search/lattice path. The identity sub-case
 * (an all-`kₘ = 0` smoothed trajectory) is the `M`-sample-delay all-pass
 * above (crest-invariant, NOT sample-exact) — the truthful contract, not
 * a defect.
 *
 * Pure: returns a fresh array; the input signal and trajectory are not
 * mutated. Output length === input length (the order-`M` all-pass group
 * delay — including the identity case's exact `M`-sample bulk delay — is
 * a bounded internal latency; true peak / crest factor are shift-invariant
 * so it does not affect the node's objective).
 */
export function processLatticeChannel(signal: Float32Array, smoothedTrajectory: ControlTrajectory, strength: number, order: number, hopSize: number): Float32Array {
	const length = signal.length;
	const output = new Float32Array(length);
	const rows = smoothedTrajectory.rows;
	const frameCount = rows.length;
	// Per-section z⁻¹ state (the delayed `aₘ` of each first-order section).
	const state = new Float32Array(order);

	for (let sample = 0; sample < length; sample++) {
		// Linear interpolation of the smoothed reflection-coefficient
		// trajectory from the frame axis to the sample axis (hop-spaced
		// control points). Keeps `kₘ` continuous between frames so the
		// time-variation is smooth (the smoothing already band-limited it).
		const framePos = hopSize > 0 ? sample / hopSize : 0;
		const frame0 = Math.min(frameCount - 1, Math.max(0, Math.floor(framePos)));
		const frame1 = Math.min(frameCount - 1, frame0 + 1);
		const fraction = framePos - frame0;
		const row0 = rows[frame0] ?? smoothedTrajectory.identity;
		const row1 = rows[frame1] ?? smoothedTrajectory.identity;

		let signalValue = signal[sample] ?? 0;

		for (let section = 0; section < order; section++) {
			const interpolated = (row0[section] ?? 0) + fraction * ((row1[section] ?? 0) - (row0[section] ?? 0));
			let kCoeff = strength * interpolated;

			if (kCoeff > MAX_REFLECTION) kCoeff = MAX_REFLECTION;
			else if (kCoeff < -MAX_REFLECTION) kCoeff = -MAX_REFLECTION;

			const cCoeff = Math.sqrt(Math.max(0, 1 - kCoeff * kCoeff));
			const delayed = state[section] ?? 0;
			// Orthogonal first-order normalized all-pass section (RMV Fig.
			// 4(b)): the 2×2 map is energy-preserving every sample.
			const toDelay = cCoeff * signalValue + kCoeff * delayed; // → next sₘ
			const sectionOut = -kCoeff * signalValue + cCoeff * delayed; // → xₘ₊₁

			state[section] = toDelay;
			signalValue = sectionOut;
		}

		output[sample] = signalValue;
	}

	return output;
}
