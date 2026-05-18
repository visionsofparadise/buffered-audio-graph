// Schroeder (1970) near-optimal low-crest phase, as reproduced verbatim in
// Ojarand & Min (2017) §I.A Eqs. (2)–(3), DOI 10.5755/j01.eie.23.2.18001 —
// see design-crest-reduce.md §Algorithm Specification item 1 (general
// spectrum-adaptive form; flat-spectrum quadratic special case) and item 1's
// Boyd §IV/§VI achievable crest-factor figures (Newman ≈ 4.6 dB,
// Shapiro-Rudin ≤ 6 dB real-signal) used to make `strength` well-defined.

/**
 * Boyd (1986) §IV/§VI achievable crest-factor figure for the Newman
 * quadratic-phase near-optimal construction: ≈ 4.6 dB ("about 4.6 dB for
 * moderate N … In all cases smaller than 4.6 dB"). This is the practical
 * near-optimal floor a phase-only transform can reach for a generic
 * dense spectrum, and is what makes the node's `strength` parameter
 * well-defined: `strength` interpolates the input crest factor toward
 * this estimated achievable floor rather than acting as an arbitrary
 * dial (design-crest-reduce.md §Algorithm Specification item 1; §Current
 * Design "the floor makes the strength parameter well-defined").
 */
export const NEWMAN_ACHIEVABLE_CREST_FACTOR_DB = 4.6;

/**
 * Boyd (1986) §III + Appendix II achievable crest-factor figure for the
 * Shapiro-Rudin construction on the real multitone signal:
 * `CF(u) ≤ 2` ⇒ ≤ 6.02 dB (proved for a power-of-two tone count). The
 * looser, provable bound; retained alongside the Newman figure as the
 * conservative achievable-floor estimate (design-crest-reduce.md
 * §Algorithm Specification item 1, transcription-error correction:
 * the √2/≈3 dB figure is only the complex-signal remark / Kahane
 * asymptotic, NOT the real-signal §III theorem).
 */
export const SHAPIRO_RUDIN_ACHIEVABLE_CREST_FACTOR_DB = 6.02;

/**
 * Relative power per bin from a frame's magnitude spectrum, normalized so
 * `Σ p_i = 1` (the `p_i` of Ojarand & Min Eq. (2)). `magnitude[i]` is the
 * linear magnitude `|X_i|` of bin `i`; power is `|X_i|²`. A silent /
 * all-zero frame (total power 0) returns a uniform distribution
 * (`1/binCount`) — the flat-spectrum limit, which feeds the quadratic
 * special case below and yields a well-defined (identity-safe) phase.
 *
 * Pure: allocates and returns a fresh array; does not mutate `magnitude`.
 */
export function relativePower(magnitude: ReadonlyArray<number> | Float32Array): Float32Array {
	const binCount = magnitude.length;
	const power = new Float32Array(binCount);

	if (binCount === 0) return power;

	let total = 0;

	for (let bin = 0; bin < binCount; bin++) {
		const value = magnitude[bin] ?? 0;
		const binPower = value * value;

		power[bin] = binPower;
		total += binPower;
	}

	if (total <= 0) {
		power.fill(1 / binCount);

		return power;
	}

	for (let bin = 0; bin < binCount; bin++) {
		power[bin] = (power[bin] ?? 0) / total;
	}

	return power;
}

/**
 * General spectrum-adaptive Schroeder near-optimal phase target for a
 * frame, per Ojarand & Min (2017) §I.A Eq. (2) (verbatim, attributed
 * there to Schroeder 1970):
 *
 *   Φ_i = Φ_1 − 2π Σ_{j=1}^{i−1} (k − j) p_j
 *
 * where `k = binCount` is the number of spectral components, `p_j` the
 * relative power of bin `j` (`Σ p_j = 1`), and `Φ_1` an additive constant
 * (Schroeder's empirical ad-hoc addend; passed in so the per-frame
 * bounded search can sweep it — design-crest-reduce.md §Algorithm
 * Specification item 1 "`Φ_1` is a free constant the per-frame fit may
 * sweep"). The inner sum is the running (cumulative) partial sum up to
 * `i − 1`: this is the only interpretation that is genuinely
 * spectrum-adaptive and that reduces to the flat-spectrum quadratic
 * special case (Eq. (3) below) under equal powers.
 *
 * For the equal-power (flat) frame, Eq. (2) reduces to Ojarand & Min
 * Eq. (3) `Φ_i = Φ_1 − π i² / k` (the quadratic / "swept-sine" phase;
 * the `i²` vs `k(k−1)` and ± sign differences across reproductions are
 * the standard sine-vs-cosine / index-base bookkeeping noted in the
 * design doc — both encode the same quadratic progression). This
 * function always evaluates the general cumulative form; `relativePower`
 * collapses a flat / silent frame onto the uniform distribution so the
 * general form *is* the quadratic special case for those frames.
 *
 * Returns the per-bin target phase in radians, length `binCount`,
 * unwrapped (NOT wrapped to (−π, π]) — the cumulative sum grows large;
 * consumers that need a wrapped angle wrap at the point of use. Pure:
 * fresh array, no mutation of inputs.
 *
 * @param magnitude Per-bin linear magnitude spectrum `|X_i|` of the frame.
 * @param phi1 The additive constant `Φ_1` (radians); 0 is the canonical
 *   choice and the identity-safe default.
 */
export function schroederTargetPhase(magnitude: ReadonlyArray<number> | Float32Array, phi1 = 0): Float32Array {
	const binCount = magnitude.length;
	const phase = new Float32Array(binCount);

	if (binCount === 0) return phase;

	const power = relativePower(magnitude);
	// `cumulative` holds Σ_{j=1}^{i−1} (k − j) p_j. Bin index `i` is
	// 1-based in Eq. (2); bin 0 (i = 1) has an empty inner sum, so its
	// phase is exactly Φ_1.
	let cumulative = 0;

	for (let bin = 0; bin < binCount; bin++) {
		phase[bin] = phi1 - 2 * Math.PI * cumulative;

		// Accumulate the (k − j) p_j term for j = bin + 1 (1-based) so the
		// NEXT bin sees the partial sum up to its i − 1.
		const oneBasedIndex = bin + 1;

		cumulative += (binCount - oneBasedIndex) * (power[bin] ?? 0);
	}

	return phase;
}

/**
 * Estimated achievable crest factor (dB) for a frame, used to make
 * `strength` well-defined: `strength` interpolates the frame's input
 * crest factor toward this floor. Per design-crest-reduce.md §Algorithm
 * Specification item 1, the practical near-optimal figure is Boyd's
 * Newman ≈ 4.6 dB; a phase-only transform cannot push a generic
 * spectrum below it. The estimate is the Newman figure clamped to never
 * exceed the frame's own input crest factor (a frame already below the
 * generic floor — e.g. a single tone — must not have its target floor
 * set ABOVE where it already sits, which would imply "worsening is the
 * target"; the never-worsen rule is the hard guarantee, this clamp keeps
 * the floor self-consistent).
 *
 * @param inputCrestFactorDb The frame's measured input crest factor (dB).
 */
export function achievableCrestFactorDb(inputCrestFactorDb: number): number {
	if (!Number.isFinite(inputCrestFactorDb)) return NEWMAN_ACHIEVABLE_CREST_FACTOR_DB;

	return Math.min(NEWMAN_ACHIEVABLE_CREST_FACTOR_DB, inputCrestFactorDb);
}
