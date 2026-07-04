// Schroeder (1970) near-optimal low-crest phase, per Ojarand & Min (2017) §I.A Eqs. (2)–(3),
// DOI 10.5755/j01.eie.23.2.18001 — see design-crest-reduce.md §Algorithm Specification item 1.

// Boyd (1986) §IV/§VI Newman achievable crest-factor floor.
export const NEWMAN_ACHIEVABLE_CREST_FACTOR_DB = 4.6;

// Boyd (1986) §III Shapiro-Rudin real-signal achievable crest-factor bound (CF ≤ 2 ⇒ ≤ 6.02 dB).
export const SHAPIRO_RUDIN_ACHIEVABLE_CREST_FACTOR_DB = 6.02;

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
		// silent frame → uniform distribution (flat-spectrum limit)
		power.fill(1 / binCount);

		return power;
	}

	for (let bin = 0; bin < binCount; bin++) {
		power[bin] = (power[bin] ?? 0) / total;
	}

	return power;
}

// Ojarand & Min (2017) Eq. (2) Schroeder near-optimal phase — see design-crest-reduce §Algorithm Specification item 1.
export function schroederTargetPhase(magnitude: ReadonlyArray<number> | Float32Array, phi1 = 0): Float32Array {
	const binCount = magnitude.length;
	const phase = new Float32Array(binCount);

	if (binCount === 0) return phase;

	const power = relativePower(magnitude);
	// cumulative holds Σ (k−j)p_j; bin i is 1-based in Eq. (2), so bin 0 has an empty inner sum ⇒ phase Φ_1.
	let cumulative = 0;

	for (let bin = 0; bin < binCount; bin++) {
		phase[bin] = phi1 - 2 * Math.PI * cumulative;

		const oneBasedIndex = bin + 1;

		cumulative += (binCount - oneBasedIndex) * (power[bin] ?? 0);
	}

	return phase;
}

export function achievableCrestFactorDb(inputCrestFactorDb: number): number {
	if (!Number.isFinite(inputCrestFactorDb)) return NEWMAN_ACHIEVABLE_CREST_FACTOR_DB;

	return Math.min(NEWMAN_ACHIEVABLE_CREST_FACTOR_DB, inputCrestFactorDb);
}
