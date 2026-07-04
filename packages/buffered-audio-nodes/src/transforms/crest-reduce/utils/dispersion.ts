// Abel & Smith (2006), DAFx-06 §2–3 Eq. (1)–(12) — see design-crest-reduce.md §Algorithm Specification item 9.
// (a) Schroeder→δ and (b) β schedule are project glue, not Abel & Smith — see design-crest-reduce item 9.

import { schroederTargetPhase } from "./schroeder";

// RMV §III |k|<1 stability clamp; kept in sync with lattice.ts.
const MAX_POLE_RADIUS = 0.95;

// β = 0.5 constant (project choice; Abel & Smith leave β free).
export function betaForBand(_bandIndex: number): number {
	return 0.5;
}

export function schroederTargetToDelay(magnitude: ReadonlyArray<number> | Float32Array, amount = 1): Float32Array {
	const binCount = magnitude.length;
	const delay = new Float32Array(binCount);

	if (binCount < 2) return delay;

	const phase = schroederTargetPhase(magnitude);
	const dOmega = Math.PI / (binCount - 1);
	const scale = Math.max(0, Math.min(1, amount));

	for (let bin = 0; bin < binCount; bin++) {
		const lo = bin === 0 ? 0 : bin - 1;
		const hi = bin === binCount - 1 ? binCount - 1 : bin + 1;
		const dPhi = (phase[hi] ?? 0) - (phase[lo] ?? 0);
		const span = (hi - lo) * dOmega;
		// τ = −dφ/dω; Schroeder φ monotone-decreasing ⇒ τ ≥ 0.
		const tau = span > 0 ? -dPhi / span : 0;

		delay[bin] = scale * Math.max(0, tau);
	}

	return delay;
}

// Abel & Smith Eq. (10)–(12): the narrow-band approx (Δ≪1) avoids the η−√(η²−1) catastrophic cancellation as η→1.
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

export function designDispersionAllpass(
	delay: ReadonlyArray<number> | Float32Array,
	order: number,
): { denominator: Float32Array; poles: Array<{ rho: number; theta: number }> } {
	const binCount = delay.length;
	const poles: Array<{ rho: number; theta: number }> = [];

	if (binCount < 2 || order <= 0) return { denominator: Float32Array.from([1]), poles };

	const dOmega = Math.PI / (binCount - 1);

	let rawHalfArea = 0;

	for (let bin = 0; bin < binCount - 1; bin++) {
		rawHalfArea += 0.5 * ((delay[bin] ?? 0) + (delay[bin + 1] ?? 0)) * dOmega;
	}

	let naturalOrder = Math.round(rawHalfArea / Math.PI);

	if (naturalOrder < 0) naturalOrder = 0;

	const bandOrder = Math.min(order, naturalOrder);
	const scaled = new Float32Array(binCount);
	let constantDelay = 0;

	if (bandOrder <= 0) {
		return { denominator: Float32Array.from([1]), poles };
	}

	if (rawHalfArea > bandOrder * Math.PI && rawHalfArea > 0) {
		const areaScale = (bandOrder * Math.PI) / rawHalfArea;

		for (let bin = 0; bin < binCount; bin++) scaled[bin] = areaScale * (delay[bin] ?? 0);
	} else {
		for (let bin = 0; bin < binCount; bin++) scaled[bin] = delay[bin] ?? 0;

		constantDelay = Math.max(0, (bandOrder * Math.PI - rawHalfArea) / Math.PI);
	}

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
		// δ' ≡ 0 (identity target — no headroom / silent frame): identity all-pass, all-zero trajectory.
		return { denominator: Float32Array.from([1]), poles };
	}

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
		const rho = poleRadius(omegaHi, betaForBand(bandIndex));

		poles.push({ rho, theta: 0 });
		convolve([1, -rho]); // (1 − ρ z⁻¹), a real pole at +ρ
		degree += 1;
		bandIndex += 1;
	}

	let areaCursor = Math.PI;
	const EPS = 1e-6;

	while (bandOrder * Math.PI - areaCursor >= 2 * Math.PI - EPS && degree + 2 <= order) {
		const omegaLo = omegaAtArea(areaCursor);
		const omegaHi = omegaAtArea(areaCursor + 2 * Math.PI);
		// Eq. (8): θ = (ω₊+ω₋)/2; Eq. (11): Δ = (ω₊−ω₋)/2.
		const theta = (omegaLo + omegaHi) / 2;
		const halfWidth = (omegaHi - omegaLo) / 2;
		const rho = poleRadius(halfWidth, betaForBand(bandIndex));

		poles.push({ rho, theta });
		convolve([1, -2 * rho * Math.cos(theta), rho * rho]); // interior conjugate-pair → real biquad
		degree += 2;
		bandIndex += 1;
		areaCursor += 2 * Math.PI;
	}

	if (bandOrder * Math.PI - areaCursor >= Math.PI - EPS && degree + 1 <= order) {
		const omegaLo = omegaAtArea(areaCursor);
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
