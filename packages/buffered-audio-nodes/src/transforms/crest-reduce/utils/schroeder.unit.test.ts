import { describe, expect, it } from "vitest";
import { achievableCrestFactorDb, NEWMAN_ACHIEVABLE_CREST_FACTOR_DB, relativePower, schroederTargetPhase } from "./schroeder";

/**
 * Independent closed-form reference for Ojarand & Min Eq. (2)
 * `Φ_i = Φ_1 − 2π Σ_{j=1}^{i−1} (k − j) p_j`, computed from controlled
 * inputs (not by calling the unit under test). `power` must already sum
 * to 1.
 */
function referencePhase(power: ReadonlyArray<number>, phi1: number): Array<number> {
	const binCount = power.length;
	const out: Array<number> = [];

	for (let oneBasedI = 1; oneBasedI <= binCount; oneBasedI++) {
		let sum = 0;

		for (let oneBasedJ = 1; oneBasedJ <= oneBasedI - 1; oneBasedJ++) {
			sum += (binCount - oneBasedJ) * (power[oneBasedJ - 1] ?? 0);
		}

		out.push(phi1 - 2 * Math.PI * sum);
	}

	return out;
}

describe("relativePower", () => {
	it("normalizes |X|² so the bins sum to 1 (a non-flat spectrum)", () => {
		// Magnitudes → powers 1, 4, 9, 16 → total 30.
		const power = relativePower([1, 2, 3, 4]);

		// Float32Array storage → ~7 significant digits; 6 decimal places
		// is the f32-appropriate tolerance (these values are O(0.1)).
		expect(power.length).toBe(4);
		expect(power[0]).toBeCloseTo(1 / 30, 6);
		expect(power[1]).toBeCloseTo(4 / 30, 6);
		expect(power[2]).toBeCloseTo(9 / 30, 6);
		expect(power[3]).toBeCloseTo(16 / 30, 6);

		let total = 0;

		for (const value of power) total += value;

		expect(total).toBeCloseTo(1, 5);
	});

	it("returns a uniform distribution for a silent (zero-power) frame", () => {
		const power = relativePower([0, 0, 0, 0, 0]);

		for (const value of power) expect(value).toBeCloseTo(1 / 5, 6);
	});

	it("returns an empty array for an empty spectrum", () => {
		expect(relativePower([]).length).toBe(0);
	});
});

describe("schroederTargetPhase", () => {
	it("matches the transcribed Eq. (2) closed form on a known non-flat spectrum", () => {
		// Arbitrary non-flat magnitude spectrum.
		const magnitude = [0.5, 2, 1, 3, 0.25, 1.5];
		const phi1 = 0.37;
		const power = relativePower(magnitude);
		const expected = referencePhase(Array.from(power), phi1);
		const actual = schroederTargetPhase(magnitude, phi1);

		expect(actual.length).toBe(magnitude.length);

		for (let bin = 0; bin < magnitude.length; bin++) {
			// f32 storage → ~7 significant digits; phases here are O(10),
			// so 4 decimal places is the f32-appropriate tolerance.
			expect(actual[bin]).toBeCloseTo(expected[bin] ?? Number.NaN, 4);
		}
	});

	it("bin 0 (i = 1) has an empty inner sum, so its phase is exactly Φ_1", () => {
		const phase = schroederTargetPhase([3, 1, 4, 1, 5], 1.234);

		// Phase is stored as Float32Array (codebase convention for
		// spectral arrays); f32 carries ~7 significant digits, so the
		// tolerance is f32-appropriate, not arbitrarily loosened.
		expect(phase[0]).toBeCloseTo(1.234, 5);
	});

	it("reduces to the quadratic special case Φ_i = Φ_1 − π i²/k for a flat spectrum", () => {
		// Flat magnitude ⇒ p_j = 1/k. Eq. (2) becomes a quadratic in i.
		// Ojarand & Min Eq. (3) prints the special case as Φ_1 − π i²/k;
		// the design doc notes the constant/linear terms differ by the
		// standard sine-vs-cosine + index-base bookkeeping (a per-bin
		// offset that is linear in i, plus multiples of 2π). The
		// load-bearing, convention-free invariant is that the SECOND
		// difference of the phase sequence is constant and equals the
		// quadratic curvature +2π/k (i.e. the phase is exactly quadratic
		// in the bin index with the Schroeder curvature: for flat p=1/k,
		// Δ²Φ_i = −2π[(k−(i+1)) − (k−i)]/k = +2π/k).
		const binCount = 16;
		const flat = new Array<number>(binCount).fill(1);
		const phase = schroederTargetPhase(flat, 0);
		const curvature = (2 * Math.PI) / binCount;

		for (let bin = 1; bin < binCount - 1; bin++) {
			const secondDifference = (phase[bin + 1] ?? 0) - 2 * (phase[bin] ?? 0) + (phase[bin - 1] ?? 0);

			expect(secondDifference).toBeCloseTo(curvature, 5);
		}
	});

	it("is spectrum-adaptive — a non-flat spectrum is NOT the flat quadratic", () => {
		const binCount = 16;
		const flat = new Array<number>(binCount).fill(1);
		const peaky = new Array<number>(binCount).fill(0.01);

		peaky[3] = 5;
		peaky[10] = 3;

		const flatPhase = schroederTargetPhase(flat, 0);
		const peakyPhase = schroederTargetPhase(peaky, 0);

		let maxDelta = 0;

		for (let bin = 0; bin < binCount; bin++) {
			maxDelta = Math.max(maxDelta, Math.abs((flatPhase[bin] ?? 0) - (peakyPhase[bin] ?? 0)));
		}

		// A concentrated spectrum produces a materially different target
		// phase than the flat quadratic — the whole point of the general
		// (Eq. 2) form over the (Eq. 3) special case.
		expect(maxDelta).toBeGreaterThan(1);
	});

	it("returns an empty array for an empty spectrum (no throw)", () => {
		expect(schroederTargetPhase([], 0).length).toBe(0);
	});
});

describe("achievableCrestFactorDb", () => {
	it("returns the Newman ≈ 4.6 dB floor for a high-crest input", () => {
		expect(achievableCrestFactorDb(18)).toBeCloseTo(NEWMAN_ACHIEVABLE_CREST_FACTOR_DB, 12);
	});

	it("clamps to the input when the frame already sits below the generic floor", () => {
		// A single tone has crest factor 3 dB < 4.6 dB; the target floor
		// must not be set ABOVE where the frame already sits.
		expect(achievableCrestFactorDb(3)).toBeCloseTo(3, 12);
	});

	it("falls back to the Newman figure for a non-finite input", () => {
		expect(achievableCrestFactorDb(Number.NEGATIVE_INFINITY)).toBeCloseTo(NEWMAN_ACHIEVABLE_CREST_FACTOR_DB, 12);
	});
});
