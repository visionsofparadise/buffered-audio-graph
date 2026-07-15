import { describe, expect, it } from "vitest";
import { betaForBand, designDispersionAllpass, poleRadius, schroederTargetToDelay } from "./dispersion";
import { stepDownToReflection } from "./lattice";

function makeDenseMagnitude(bins: number): Float32Array {
	// A non-flat magnitude spectrum (energy concentrated low, tapering up).
	const mag = new Float32Array(bins);

	for (let bin = 0; bin < bins; bin++) mag[bin] = 1 / (1 + bin / 8);

	return mag;
}

/**
 * Independent closed-form reference for a first-order all-pass section's
 * group delay (Abel & Smith Eq. 3) `τ(ω) = (1−ρ²)/(1+ρ²−2ρcos(ω−θ))`.
 */
function sectionGroupDelay(rho: number, theta: number, omega: number): number {
	return (1 - rho * rho) / (1 + rho * rho - 2 * rho * Math.cos(omega - theta));
}

/** Raw (wrapped) phase of `A(e^{jω}) = z⁻ᴹ D(z⁻¹)/D(z)`: arg A = −2·arg(D) − M·ω. */
function rawAllpassPhase(denominator: Float32Array, w: number): number {
	let re = 0;
	let im = 0;

	for (let k = 0; k < denominator.length; k++) {
		const d = denominator[k] ?? 0;

		re += d * Math.cos(-k * w);
		im += d * Math.sin(-k * w);
	}

	const m = denominator.length - 1;

	return -2 * Math.atan2(im, re) - m * w;
}

/**
 * Group delay of a real polynomial all-pass at `ω` via a central
 * difference of the LOCALLY-UNWRAPPED phase (independent of the unit under
 * test). The `atan2` term wraps, so the two phase samples are unwrapped
 * relative to each other before differencing.
 */
function polyAllpassGroupDelay(denominator: Float32Array, omega: number): number {
	const h = 1e-5;
	let pa = rawAllpassPhase(denominator, omega - h);
	let pb = rawAllpassPhase(denominator, omega + h);

	// Unwrap pb toward pa (the −2·atan2 term jumps by ≤ 4π between the
	// closely-spaced samples; bring them onto the same branch).
	while (pb - pa > Math.PI) pb -= 2 * Math.PI;
	while (pb - pa < -Math.PI) pb += 2 * Math.PI;

	return -(pb - pa) / (2 * h);
}

/**
 * ∫₀^π τ(ω) dω of a real polynomial all-pass via continuous unwrapped
 * phase accumulation over a fine grid: ∫₀^π τ dω = −(argA(π) − argA(0))
 * (RMV 1988 Eq. 2.10–2.11: a stable order-M real all-pass's phase
 * decreases monotonically by exactly Mπ over [0, π]). Independent of the
 * unit under test.
 */
function halfBandGroupDelayArea(denominator: Float32Array, steps = 20_000): number {
	let prev = rawAllpassPhase(denominator, 0);
	let unwrapped = prev;
	let total = prev;

	for (let i = 1; i <= steps; i++) {
		const w = (Math.PI * i) / steps;
		let p = rawAllpassPhase(denominator, w);

		while (p - prev > Math.PI) p -= 2 * Math.PI;
		while (p - prev < -Math.PI) p += 2 * Math.PI;

		unwrapped += p - prev;
		prev = p;

		if (i === steps) total = unwrapped;
	}

	// ∫₀^π τ dω = argA(0) − argA(π) (τ = −dφ/dω, φ decreasing ⇒ positive).
	return rawAllpassPhase(denominator, 0) - total;
}

describe("betaForBand (project's own β schedule — declared NOT sourced)", () => {
	it("is a constant moderate β in (0, 1) for every band", () => {
		for (let band = 0; band < 16; band++) {
			const beta = betaForBand(band);

			expect(beta).toBeGreaterThan(0);
			expect(beta).toBeLessThan(1);
		}
	});
});

describe("poleRadius (Abel & Smith Eq. 10–12)", () => {
	it("matches the exact closed form ρ = η − √(η²−1), η = (1−β cosΔ)/(1−β)", () => {
		const beta = 0.5;
		const delta = 0.4; // wide enough to use the exact branch (Δ ≥ 1e-3)
		const eta = (1 - beta * Math.cos(delta)) / (1 - beta);
		const expected = eta - Math.sqrt(eta * eta - 1);

		expect(poleRadius(delta, beta)).toBeCloseTo(Math.min(0.95, expected), 6);
	});

	it("a narrower band ⇒ a larger pole radius (sharper, longer delay)", () => {
		const beta = 0.5;

		expect(poleRadius(0.05, beta)).toBeGreaterThan(poleRadius(0.5, beta));
	});

	it("the Eq. 12 (narrow-band) and Eq. 10 (exact) branches are continuous at the Δ switch", () => {
		// As Δ → 0 the Abel & Smith pole radius → 1 for ANY β (a
		// zero-width band is an infinitely sharp group-delay spike — a
		// pole on the unit circle). Eq. 12 (used for Δ < 1e-3) is the
		// numerically-robust form of Eq. 10 (used for Δ ≥ 1e-3) in that
		// limit; the correctness property the implementation must hold is
		// that `poleRadius` is CONTINUOUS across the 1e-3 branch switch
		// (no discontinuity from swapping the two equivalent forms).
		const beta = 0.5;
		const justBelow = 1e-3 * 0.999; // Eq. 12 branch
		const justAbove = 1e-3 * 1.001; // Eq. 10 branch

		expect(poleRadius(justBelow, beta)).toBeCloseTo(poleRadius(justAbove, beta), 4);

		// And the limit is sane: a moderate β at a moderate Δ gives a
		// well-conditioned interior radius (the regime the design uses),
		// matching the exact closed form.
		const dMod = 0.3;
		const etaMod = (1 - beta * Math.cos(dMod)) / (1 - beta);
		const exactMod = etaMod - Math.sqrt(etaMod * etaMod - 1);

		expect(poleRadius(dMod, beta)).toBeCloseTo(Math.min(0.95, exactMod), 6);
	});

	it("is clamped strictly inside the unit circle (normalized-lattice stability)", () => {
		// A vanishingly narrow band would push ρ → 1; must clamp ≤ 0.95.
		expect(poleRadius(1e-9, 0.99)).toBeLessThanOrEqual(0.95);
		expect(poleRadius(1e-9, 0.99)).toBeGreaterThanOrEqual(0);
	});
});

describe("schroederTargetToDelay (project's own Schroeder→δ(ω) glue — declared NOT sourced)", () => {
	it("yields a non-negative group delay (Schroeder φ is monotone-decreasing ⇒ τ ≥ 0)", () => {
		const delay = schroederTargetToDelay(makeDenseMagnitude(513), 1);

		expect(delay.length).toBe(513);

		for (const value of delay) expect(value).toBeGreaterThanOrEqual(0);
	});

	it("scales linearly with the peak-priority amount (amount 0 ⇒ identity target)", () => {
		const mag = makeDenseMagnitude(513);
		const full = schroederTargetToDelay(mag, 1);
		const half = schroederTargetToDelay(mag, 0.5);
		const zero = schroederTargetToDelay(mag, 0);

		for (let bin = 0; bin < full.length; bin++) {
			expect(half[bin]).toBeCloseTo((full[bin] ?? 0) * 0.5, 6);
			expect(zero[bin]).toBe(0);
		}
	});
});

describe("designDispersionAllpass (Abel & Smith 2006 §3 Eq. 7–12)", () => {
	it("an identity (zero) target yields the trivial all-pass D(z) = 1, no poles", () => {
		const { denominator, poles } = designDispersionAllpass(new Float32Array(513), 8);

		expect(Array.from(denominator)).toEqual([1]);
		expect(poles.length).toBe(0);
	});

	it("produces a monic, real, stable D(z) of degree ≤ order whose step-down kₘ all satisfy |kₘ| < 1", () => {
		const delay = schroederTargetToDelay(makeDenseMagnitude(1025), 1);
		const { denominator } = designDispersionAllpass(delay, 8);

		expect(denominator[0]).toBe(1);
		expect(denominator.length).toBeLessThanOrEqual(9); // degree ≤ 8

		for (const coefficient of denominator) expect(Number.isFinite(coefficient)).toBe(true);

		// RMV §III: a stable real all-pass steps down to |kₘ| < 1 at every
		// step — the escalation gate for 5F.1 (the Abel & Smith fit MUST
		// map to a stable normalized-lattice reflection set).
		const reflection = stepDownToReflection(denominator);

		expect(reflection.length).toBeGreaterThan(0);

		for (const k of reflection) {
			expect(Number.isFinite(k)).toBe(true);
			expect(Math.abs(k)).toBeLessThan(1);
		}
	});

	it("a single-pole design reproduces its own Eq. 3 group delay (per-section closed form)", () => {
		// Build a delay whose total half-band area is exactly π so the
		// design lands ONE DC-centred real-pole band; verify the resulting
		// D(z)'s group delay at DC matches the Eq. 3/Eq. 4 closed form.
		const bins = 1025;
		const delay = new Float32Array(bins);

		// Constant δ over [0, π]: area = δ·π. Choose δ so area = π ⇒ δ = 1.
		delay.fill(1);

		const { denominator, poles } = designDispersionAllpass(delay, 1);

		expect(poles.length).toBe(1);

		const { rho, theta } = poles[0] ?? { rho: 0, theta: 0 };

		expect(theta).toBeCloseTo(0, 6); // DC-centred first band

		// The polynomial all-pass group delay at a few interior ω equals
		// the Eq. 3 single-section closed form (independent reference).
		for (const omega of [0.2, 0.8, 1.5, 2.5]) {
			const reference = sectionGroupDelay(rho, theta, omega);
			const actual = polyAllpassGroupDelay(denominator, omega);

			expect(actual).toBeCloseTo(reference, 2);
		}
	});

	it("the cascade group delay integrates to degree·π (Abel & Smith Eq. 6 / RMV Eq. 2.11)", () => {
		// Abel & Smith Eq. 6: each first-order section contributes exactly
		// 2π of group-delay area around the unit circle ⇒ an order-M real
		// all-pass has ∫₀^{2π} τ dω = M·2π, i.e. ∫₀^{π} τ dω = M·π (even
		// group delay; RMV 1988 Eq. 2.11). Verify the designed D(z)'s
		// half-band group-delay area equals (degree)·π — the load-bearing
		// invariant proving the band partition is exact.
		const delay = new Float32Array(2049);

		// A genuinely dispersive target with enough area to fill order 8.
		for (let bin = 0; bin < delay.length; bin++) delay[bin] = 3 + 2 * Math.cos((4 * Math.PI * bin) / delay.length);

		const { denominator } = designDispersionAllpass(delay, 8);
		const degree = denominator.length - 1;

		expect(degree).toBeGreaterThan(0);

		const area = halfBandGroupDelayArea(denominator);

		// ∫₀^π τ dω = degree·π — within numerical phase-unwrap tolerance.
		expect(area).toBeCloseTo(degree * Math.PI, 0);
	});

	it("a peakier (higher-area) target yields a higher-order, larger-delay design than a flat one (the fit tracks the target)", () => {
		const bins = 1025;
		// `peaky`: a tall narrow low-frequency group-delay bump (large
		// area). `mild`: a low broad bump (small area).
		const peaky = new Float32Array(bins);
		const mild = new Float32Array(bins);

		for (let bin = 0; bin < bins; bin++) {
			peaky[bin] = bin < 120 ? 12 : 0.05;
			mild[bin] = 0.4;
		}

		const dPeaky = designDispersionAllpass(peaky, 8);
		const dMild = designDispersionAllpass(mild, 8);

		// The peaky target is genuinely dispersive: a non-trivial,
		// higher-order all-pass (5F.1 non-degeneracy of the fit).
		expect(dPeaky.denominator.length).toBeGreaterThan(1);
		expect(halfBandGroupDelayArea(dPeaky.denominator)).toBeGreaterThan(halfBandGroupDelayArea(dMild.denominator));
		// And it does not exceed the bounded lattice order.
		expect(dPeaky.denominator.length - 1).toBeLessThanOrEqual(8);
	});
});
