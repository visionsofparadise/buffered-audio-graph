// Abel & Smith (2006) closed-form target-group-delay → order-N
// cascaded-biquad all-pass design — the per-frame fitting step.
//
// Algorithm source (read in full, verbatim-transcribed): all-pass
// group-delay design — Abel, J. S. & Smith, J. O., "Robust Design of Very
// High-Order Allpass Dispersion Filters," Proc. 9th Int. Conf. on Digital
// Audio Effects (DAFx-06), Montréal, Sept. 18–20 2006, pp. DAFX-13…18,
// §2–3 Eq. (1)–(12) — see design-crest-reduce.md §Algorithm Specification
// item 9. Specifically:
//   - the first-order all-pass G(z) = (−ρe^{−jθ} + z⁻¹)/(1 − ρe^{jθ}z⁻¹)
//     (Abel & Smith Eq. 1) with group delay
//     τ(ω) = (1−ρ²)/(1+ρ²−2ρcos(ω−θ)) (Eq. 3), peak (1+ρ)/(1−ρ) at ω=θ
//     (Eq. 4), and the 2π-per-pole invariant ∫₀^{2π} τ dω = 2π (Eq. 6);
//   - the §3 band-segmentation design: add a constant delay so δ(ω)
//     integrates to N·2π (step 1); divide δ(ω) into 2π-area bands from DC
//     (step 2); per band θ = (ω₊+ω₋)/2 (Eq. 8), τ(ω±) = β·max τ (Eq. 9),
//     ρ(β) = η − √(η²−1) (Eq. 10), η = (1−β cosΔ)/(1−β), Δ = (ω₊−ω₋)/2
//     (Eq. 11), narrow-band approx ρ ≈ 1 − √(β/(1−β))·Δ (Eq. 12);
//     cascade D(z) = ∏ Gₙ(z) (Eq. 7); the first band centred on DC yields
//     real-coefficient biquads.
//
// The resulting D(z) maps to the normalized-lattice reflection
// coefficients by the RMV-1988 §III Eq. 3.3a/3.3b step-down
// (`stepDownToReflection` in lattice.ts — item 8 part (c).2, sourced
// verbatim, unchanged).
//
// ── PROJECT'S OWN DESIGN CHOICE (NOT sourced — explicitly labelled per
// the keystone "Honest contribution boundary" and §Algorithm
// Specification item 9 "Attribution for the code phase"; Abel & Smith
// leave β user-supplied / optionally frequency-dependent and do not
// specify where δ(ω) comes from). The only two glue pieces are:
//   (a) the per-frame peak-prioritised Schroeder-target-phase → desired
//       group delay δ(ω) mapping (`schroederTargetToDelay`): differentiate
//       the project's Schroeder-derived per-frame target phase
//       (§Algorithm Specification item 1, schroeder.ts, reused unmodified)
//       and scale it by the windowed peak-priority amount;
//   (b) the per-band β schedule (`betaForBand`): Abel & Smith leave β as a
//       user-supplied, optionally frequency-dependent smoothness control;
//       the schedule chosen here is the project's own engineering choice.
// Neither (a) nor (b) is claimed as sourced. Everything else in this
// module is the verbatim Abel & Smith §2–3 procedure. ──

import { schroederTargetPhase } from "./schroeder";

/**
 * Reflection coefficients are clamped strictly inside the unit circle so
 * the normalized Givens section's `√(1−kₘ²)` stays real and bounded away
 * from 0. RMV §III guarantees `|kₘ| < 1` for a stable all-pass; this is
 * the same numerical-stability clamp `lattice.ts` applies (kept in sync).
 */
const MAX_POLE_RADIUS = 0.95;

/**
 * (b) PROJECT'S OWN DESIGN CHOICE — the per-band β schedule. NOT sourced:
 * Abel & Smith (2006) §3/§4 explicitly leave β as a user-supplied,
 * optionally frequency-dependent smoothness control ("β near 1 → smooth
 * group delay; small β → ripple but tracks narrow features … β may be
 * adjusted in proportion to a local measure of the smoothness of δ(ω)").
 * They do not prescribe a schedule.
 *
 * The project chooses a single moderately-smooth constant β = 0.5: the
 * fraction of each section's peak group delay reached at its band edges.
 * β = 0.5 gives a well-conditioned mid-range pole radius (Eq. 10–11) for
 * the bounded-order, perceptually-transparent design — neither the
 * rippling small-β regime nor the ρ→1 (long-delay, non-transparent)
 * large-β regime. This constant is the project's design choice, declared
 * here, not presented as Abel & Smith's.
 *
 * @param _bandIndex Band ordinal (0 = the DC-centred first band). Unused
 *   by the constant schedule; the parameter documents that a
 *   frequency-dependent schedule is the sanctioned Abel & Smith extension
 *   point and would key off this.
 */
export function betaForBand(_bandIndex: number): number {
	return 0.5;
}

/**
 * (a) PROJECT'S OWN DESIGN CHOICE — map the per-frame peak-prioritised
 * Schroeder target phase to Abel & Smith's desired group delay δ(ω). NOT
 * sourced: Abel & Smith (2006) take δ(ω) as a given input and do not
 * specify its origin; differentiating the project's Schroeder-derived
 * per-frame target phase to obtain it is the project's integration glue.
 *
 * The Schroeder target phase (Ojarand & Min Eq. (2), §Algorithm
 * Specification item 1, `schroederTargetPhase`) is the project's
 * peak-prioritised per-frame target; it is unwrapped and
 * monotone-decreasing in bin index. Group delay is `τ(ω) = −dφ/dω`
 * (positive, since φ decreases). It is sampled at `binCount` points
 * uniformly spaced over the half-band `ω ∈ [0, π]` (bin `i` → `ω = πi/(binCount−1)`).
 * `amount ∈ [0, 1]` is the windowed peak-priority dispersion scale (the
 * project's peak-prioritised windowed targeting, applied by the caller);
 * δ is linearly scaled by it so frames with no coincident-peak headroom
 * map to ≈0 delay (≈identity, the principled targeting outcome).
 *
 * Returns the desired group delay (samples) per bin over `[0, π]`,
 * floored at 0 (a group delay is non-negative). Pure: fresh array.
 *
 * @param magnitude Per-bin linear magnitude spectrum `|X_i|` of the frame.
 * @param amount Windowed peak-priority dispersion scale in `[0, 1]`.
 */
export function schroederTargetToDelay(magnitude: ReadonlyArray<number> | Float32Array, amount = 1): Float32Array {
	const binCount = magnitude.length;
	const delay = new Float32Array(binCount);

	if (binCount < 2) return delay;

	const phase = schroederTargetPhase(magnitude);
	// dω between adjacent bins over [0, π]: π / (binCount − 1).
	const dOmega = Math.PI / (binCount - 1);
	const scale = Math.max(0, Math.min(1, amount));

	for (let bin = 0; bin < binCount; bin++) {
		// Central difference for the interior, one-sided at the edges.
		const lo = bin === 0 ? 0 : bin - 1;
		const hi = bin === binCount - 1 ? binCount - 1 : bin + 1;
		const dPhi = (phase[hi] ?? 0) - (phase[lo] ?? 0);
		const span = (hi - lo) * dOmega;
		// τ = −dφ/dω; Schroeder φ is monotone-decreasing ⇒ τ ≥ 0.
		const tau = span > 0 ? -dPhi / span : 0;

		delay[bin] = scale * Math.max(0, tau);
	}

	return delay;
}

/**
 * The closed-form pole radius for a band, Abel & Smith (2006) §3
 * Eq. (10)–(12), verbatim:
 *
 *   ρ(β) = η − √(η² − 1),   η = (1 − β cosΔ)/(1 − β),   Δ = (ω₊−ω₋)/2
 *
 * with the narrow-band approximation `ρ ≈ 1 − √(β/(1−β))·Δ` (Eq. 12) used
 * when `Δ ≪ 1` (numerically the exact form and the approximation agree
 * there; the approximation avoids the `η − √(η²−1)` catastrophic
 * cancellation as `η → 1`). `β` is the fraction of the section's peak
 * group delay reached at the band edges (Eq. 9). Returns `ρ` clamped to
 * `[0, MAX_POLE_RADIUS]` for normalized-lattice numerical stability.
 *
 * @param halfWidth Δ = (ω₊ − ω₋)/2, the band half-width in radians.
 * @param beta The Abel & Smith smoothness parameter β ∈ (0, 1).
 */
export function poleRadius(halfWidth: number, beta: number): number {
	const delta = Math.max(0, halfWidth);
	const betaClamped = Math.max(1e-6, Math.min(1 - 1e-6, beta));

	let rho: number;

	if (delta < 1e-3) {
		// Eq. (12) narrow-band approximation (Δ ≪ 1).
		rho = 1 - Math.sqrt(betaClamped / (1 - betaClamped)) * delta;
	} else {
		// Eq. (10)–(11) exact closed form.
		const eta = (1 - betaClamped * Math.cos(delta)) / (1 - betaClamped);

		rho = eta - Math.sqrt(Math.max(0, eta * eta - 1));
	}

	if (!Number.isFinite(rho)) return 0;

	return Math.max(0, Math.min(MAX_POLE_RADIUS, rho));
}

/**
 * Design an order-`N` real all-pass denominator `D(z)` matching a desired
 * group delay `δ(ω)` by the Abel & Smith (2006) §3 band-segmentation
 * procedure (Eq. 7–12), verbatim.
 *
 * `delay` is `δ(ω)` sampled uniformly over the half-band `ω ∈ [0, π]`
 * (bin `i` → `ω = πi/(binCount−1)`), in samples (the project's
 * `schroederTargetToDelay` output). A real all-pass has an even group
 * delay (`τ(2π−ω) = τ(ω)`), so the `[0, π]` samples fully determine the
 * design and the band partition is built directly on `[0, π]` with
 * half-circle area target `N·π` (the full-circle `N·2π` halved by
 * symmetry):
 *
 *   1. (Eq., step 1) Add a constant delay so the area integrates to the
 *      target. The constant is a non-negative bulk delay (a constant
 *      delay can only be ADDED — you cannot remove latency a filter does
 *      not have); if the raw area already exceeds the target the desired
 *      δ is uniformly scaled down to fit `N` poles (Abel & Smith pick `N`
 *      ≥ the natural area; here `N = LATTICE_ORDER` is fixed by the
 *      lattice, so the target is scaled to the available order — this
 *      scaling is the project's own bounded-order adaptation, declared).
 *   2. (step 2) Starting at DC, walk `ω` accumulating `∫δ dω`; a band
 *      edge falls every time the running area crosses an odd multiple of
 *      `π` for the DC-centred first band then every `2π`-equivalent
 *      (`π` per half-band step → real biquad bands). The FIRST band is
 *      centred on DC (first edge where `∫₀^{ω} δ = π`), giving a real
 *      pole at `θ = 0`; an optional final band centred on Nyquist gives a
 *      real pole at `θ = π`; interior bands are complex-conjugate pairs
 *      combined into real biquads.
 *   3. (Eq. 8, 10–12) Per band: pole frequency `θ = (ω₊+ω₋)/2`
 *      (`betaForBand` supplies β); pole radius `ρ(β)` via `poleRadius`.
 *   4. (Eq. 7) Cascade: `D(z) = ∏ Gₙ(z)` — a DC/Nyquist real pole
 *      contributes `(1 − ρ z⁻¹)` / `(1 + ρ z⁻¹)`; an interior
 *      conjugate-pair band contributes the real biquad
 *      `(1 − 2ρ cosθ z⁻¹ + ρ² z⁻²)`.
 *
 * Returns `{ denominator: [1, d_1, …], poles: [{ rho, theta }, …] }`.
 * `denominator` is monic (`d_0 = 1`) and of degree ≤ `N` (the cascade may
 * land just under `N` when the final partial band carries < `π`
 * remaining area — that band is dropped, the design is the largest exact
 * `2π`-area-band cascade ≤ `N`, exactly Abel & Smith's "the list of band
 * edges encodes all relevant delay information"). Pure: fresh arrays.
 *
 * @param delay δ(ω) over `[0, π]` in samples.
 * @param order Desired all-pass order `N` (= `LATTICE_ORDER`).
 */
export function designDispersionAllpass(
	delay: ReadonlyArray<number> | Float32Array,
	order: number,
): { denominator: Float32Array; poles: Array<{ rho: number; theta: number }> } {
	const binCount = delay.length;
	const poles: Array<{ rho: number; theta: number }> = [];

	if (binCount < 2 || order <= 0) return { denominator: Float32Array.from([1]), poles };

	const dOmega = Math.PI / (binCount - 1);

	// Raw half-band area H = ∫₀^π δ dω (trapezoidal). The full unit-circle
	// area is 2H (a real all-pass has an even group delay).
	let rawHalfArea = 0;

	for (let bin = 0; bin < binCount - 1; bin++) {
		rawHalfArea += 0.5 * ((delay[bin] ?? 0) + (delay[bin + 1] ?? 0)) * dOmega;
	}

	// Step 1 (Abel & Smith §3 step 1, verbatim): "Add a constant delay to
	// the desired δ(ω) so that it integrates to a desired multiple of 2π,
	// call it N, where N is the desired allpass order." N is a free design
	// choice in Abel & Smith. The PROJECT'S ORDER-SELECTION POLICY (a
	// declared project choice, within Abel & Smith's "N is the desired
	// order" — NOT a deviation from the verbatim procedure): choose N as
	// the target's own natural 2π-area order, `round(2H / 2π) = round(H/π)`,
	// capped at the bounded lattice `order` and floored at 0. This makes
	// the design ADAPT to the target's dispersive content — a near-zero δ
	// (no-headroom / diffuse frame, amount ≈ 0) ⇒ N = 0 ⇒ the identity
	// all-pass (the principled ≈identity targeting outcome, design §Current
	// Design / keystone FUNDAMENTAL REFRAME) — rather than forcing a fixed
	// high order with a large pure-bulk-delay component. The constant delay
	// itself is still added per the verbatim step (only the MINIMAL amount
	// to round H up to the chosen integer N of π-area half-bands).
	let naturalOrder = Math.round(rawHalfArea / Math.PI);

	if (naturalOrder < 0) naturalOrder = 0;

	// If the target's natural area exceeds the bounded lattice order, the
	// design cannot realise the full desired δ with only `order` poles —
	// uniformly scale δ down to fit (the project's declared bounded-order
	// adaptation; Abel & Smith instead pick N ≥ the natural area, but here
	// the order is hard-capped by the normalized lattice). Otherwise add
	// the minimal constant delay c so 2(H + cπ) = N·2π ⇒ c = N − H/π ≥ 0
	// (round-half-up keeps the natural N ≥ H/π for the no-scaling branch
	// after the ceil fix below; a constant delay can only be ADDED).
	const bandOrder = Math.min(order, naturalOrder);
	const scaled = new Float32Array(binCount);
	let constantDelay = 0;

	if (bandOrder <= 0) {
		// Identity target (no dispersive headroom): the trivial all-pass.
		return { denominator: Float32Array.from([1]), poles };
	}

	if (rawHalfArea > bandOrder * Math.PI && rawHalfArea > 0) {
		// Natural area above the chosen (capped) N·π — scale δ down to fit
		// exactly N π-area half-bands (declared bounded-order adaptation).
		const areaScale = (bandOrder * Math.PI) / rawHalfArea;

		for (let bin = 0; bin < binCount; bin++) scaled[bin] = areaScale * (delay[bin] ?? 0);
	} else {
		for (let bin = 0; bin < binCount; bin++) scaled[bin] = delay[bin] ?? 0;

		// c·π = N·π − H  ⇒  the per-ω constant added below (c ≥ 0).
		constantDelay = Math.max(0, (bandOrder * Math.PI - rawHalfArea) / Math.PI);
	}

	// δ'(ω) = scaled(ω) + constantDelay (the Eq.-step-1 normalised delay).
	const omegaAt = (bin: number): number => bin * dOmega;
	const deltaAt = (bin: number): number => (scaled[bin] ?? 0) + constantDelay;

	// Cumulative area S(ω) = ∫₀^ω δ' dω' at each bin (trapezoidal).
	const cumulative = new Float32Array(binCount);

	for (let bin = 1; bin < binCount; bin++) {
		cumulative[bin] = (cumulative[bin - 1] ?? 0) + 0.5 * (deltaAt(bin) + deltaAt(bin - 1)) * dOmega;
	}

	const totalArea = cumulative[binCount - 1] ?? 0;
	const maxTau = (() => {
		let maxValue = 0;

		for (let bin = 0; bin < binCount; bin++) maxValue = Math.max(maxValue, deltaAt(bin));

		return maxValue;
	})();

	if (totalArea <= 0 || maxTau <= 0) {
		// δ' ≡ 0 (an identity target — no headroom / silent frame). Identity
		// all-pass: D(z) = 1, no poles. The reflection trajectory is then
		// all-zero for this frame (the principled ≈identity outcome).
		return { denominator: Float32Array.from([1]), poles };
	}

	// Linear-interpolated inverse of S(ω): the ω at which the cumulative
	// area first reaches `target` (used for the 2π-area band edges).
	const omegaAtArea = (target: number): number => {
		if (target <= 0) return 0;

		if (target >= totalArea) return Math.PI;

		let bin = 1;

		while (bin < binCount && (cumulative[bin] ?? 0) < target) bin++;

		const aLo = cumulative[bin - 1] ?? 0;
		const aHi = cumulative[bin] ?? aLo;
		const frac = aHi > aLo ? (target - aLo) / (aHi - aLo) : 0;

		return omegaAt(bin - 1) + frac * dOmega;
	};

	// Step 2 (Abel & Smith §3 step 2, verbatim — "Starting at DC, divide
	// δ(ω) into 2π-area frequency bands"; "Choosing the first band centred
	// on DC … yields real-coefficient biquads"). On the half-band [0, π]
	// (the real all-pass's even group delay is fully described there):
	//   - the DC-centred band [−ω₁, ω₁] has FULL-circle area 2π; its
	//     half-band portion [0, ω₁] is π of area → ONE real pole at θ = 0
	//     (degree 1);
	//   - each interior complex-conjugate pair is the band at +θ and its
	//     mirror at 2π−θ; the half-band portion [ω₋, ω₊] in (0, π)
	//     accounts for 2π of area → ONE real biquad (degree 2);
	//   - if N is odd a final Nyquist-centred band has half-band area π →
	//     ONE real pole at θ = π (degree 1).
	// The half-band area (`totalArea` = N·π by construction) therefore
	// partitions as π + 2π·(biquads) + [π], and the realised denominator
	// degree sums to EXACTLY N (= the chosen order).
	let polynomial: Array<number> = [1];
	let degree = 0;
	let bandIndex = 0;

	const convolve = (factor: ReadonlyArray<number>): void => {
		const next = new Array<number>(polynomial.length + factor.length - 1).fill(0);

		for (let pIdx = 0; pIdx < polynomial.length; pIdx++) {
			for (let fIdx = 0; fIdx < factor.length; fIdx++) {
				next[pIdx + fIdx] = (next[pIdx + fIdx] ?? 0) + (polynomial[pIdx] ?? 0) * (factor[fIdx] ?? 0);
			}
		}

		polynomial = next;
	};

	// Band 0 — the DC-centred real-pole band (half-band area π).
	{
		const omegaHi = omegaAtArea(Math.PI);
		// Δ = ω₁ (the symmetric full band is [−ω₁, ω₁]); θ = 0 (Eq. 8).
		const rho = poleRadius(omegaHi, betaForBand(bandIndex));

		poles.push({ rho, theta: 0 });
		convolve([1, -rho]); // (1 − ρ z⁻¹), a real pole at +ρ
		degree += 1;
		bandIndex += 1;
	}

	// Interior conjugate-pair biquad bands — each 2π of half-band area.
	let areaCursor = Math.PI;
	const EPS = 1e-6;

	while (bandOrder * Math.PI - areaCursor >= 2 * Math.PI - EPS && degree + 2 <= order) {
		const omegaLo = omegaAtArea(areaCursor);
		const omegaHi = omegaAtArea(areaCursor + 2 * Math.PI);
		// Eq. (8): θ = (ω₊+ω₋)/2 (band midpoint). Eq. (11): Δ = (ω₊−ω₋)/2.
		const theta = (omegaLo + omegaHi) / 2;
		const halfWidth = (omegaHi - omegaLo) / 2;
		const rho = poleRadius(halfWidth, betaForBand(bandIndex));

		poles.push({ rho, theta });
		// Interior complex-conjugate pair → real biquad
		// (1 − 2ρ cosθ z⁻¹ + ρ² z⁻²).
		convolve([1, -2 * rho * Math.cos(theta), rho * rho]);
		degree += 2;
		bandIndex += 1;
		areaCursor += 2 * Math.PI;
	}

	// A trailing π of half-band area (odd N) → the Nyquist-centred
	// real-pole band (θ = π).
	if (bandOrder * Math.PI - areaCursor >= Math.PI - EPS && degree + 1 <= order) {
		const omegaLo = omegaAtArea(areaCursor);
		// Δ = (π − ω₋) (the symmetric full band is [ω₋, 2π−ω₋] about π).
		const rho = poleRadius(Math.PI - omegaLo, betaForBand(bandIndex));

		poles.push({ rho, theta: Math.PI });
		convolve([1, rho]); // (1 + ρ z⁻¹), a real pole at −ρ
		degree += 1;
	}

	const denominator = new Float32Array(polynomial.length);

	for (let index = 0; index < polynomial.length; index++) denominator[index] = polynomial[index] ?? 0;

	denominator[0] = 1; // structurally exact (monic); guard FP drift

	return { denominator, poles };
}
