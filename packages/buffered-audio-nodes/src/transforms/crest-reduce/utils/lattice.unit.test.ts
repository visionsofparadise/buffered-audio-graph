import { describe, expect, it } from "vitest";
import { TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";
import { extractLatticeTrajectory, LATTICE_ORDER, processLatticeChannel, stepDownToReflection } from "./lattice";
import type { ControlTrajectory } from "./trajectory";

const SAMPLE_RATE = 48_000;

/** Whole-signal 4× true peak (dBTP). A fresh accumulator per call. */
function truePeakDb(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const accumulator = new TruePeakAccumulator(sampleRate, channels.length, 4);

	accumulator.push(channels as Array<Float32Array>, channels[0]?.length ?? 0);

	return linearToDb(accumulator.finalize());
}

function makeDense(frames: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		let value = 0;

		for (const frequency of [110, 220, 330, 440, 550, 660, 1500, 3000]) value += Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);

		out[index] = (value / 8) * 0.6;
	}

	return out;
}

/** A constant (LTI) reflection-coefficient trajectory of `frames` rows. */
function staticTrajectory(poles: ReadonlyArray<number>, frames: number): ControlTrajectory {
	const order = poles.length;

	return {
		rows: Array.from({ length: frames }, () => Float32Array.from(poles)),
		laneCount: order,
		identity: new Float32Array(order),
		transientMask: new Float32Array(frames),
	};
}

/** A reflection-coefficient trajectory whose coefficients change EVERY
 * frame (the time-varying stress case — the Phase-4 Direct-Form-I
 * structure injected energy here; the normalized lattice must not). */
function timeVaryingTrajectory(order: number, frames: number): ControlTrajectory {
	const rows = Array.from({ length: frames }, (_unused, frame) => {
		const row = new Float32Array(order);

		for (let section = 0; section < order; section++) {
			// A different, sizeable coefficient set per frame.
			row[section] = 0.85 * Math.sin(0.7 * frame + 1.3 * section + 0.2);
		}

		return row;
	});

	return { rows, laneCount: order, identity: new Float32Array(order), transientMask: new Float32Array(frames) };
}

describe("stepDownToReflection (RMV 1988 §III Eq. 3.3a/3.3b)", () => {
	it("recovers reflection coefficients with |kₘ| < 1 from a stable real all-pass denominator", () => {
		// D(z) = ∏ (1 − pₘ z⁻¹), real poles strictly inside the unit circle.
		const poles = [0.6, -0.4, 0.8, -0.2];
		let polynomial: Array<number> = [1];

		for (const pole of poles) {
			const next = new Array<number>(polynomial.length + 1).fill(0);

			for (let index = 0; index < polynomial.length; index++) {
				next[index] = (next[index] ?? 0) + (polynomial[index] ?? 0);
				next[index + 1] = (next[index + 1] ?? 0) - pole * (polynomial[index] ?? 0);
			}

			polynomial = next;
		}

		const reflection = stepDownToReflection(polynomial);

		expect(reflection.length).toBe(poles.length);

		for (const coefficient of reflection) {
			expect(Number.isFinite(coefficient)).toBe(true);
			// RMV §III: |kₘ| < 1 is guaranteed at every step for a stable
			// all-pass — the structurally-induced stability the lattice
			// relies on.
			expect(Math.abs(coefficient)).toBeLessThan(1);
		}
	});

	it("returns an empty coefficient set for a trivial (order-0) denominator", () => {
		expect(stepDownToReflection([1]).length).toBe(0);
	});
});

describe("processLatticeChannel — normalized first-order section is exactly all-pass", () => {
	it("a single static section's impulse response matches the closed-form first-order all-pass (−k + z⁻¹)/(1 − k z⁻¹)", () => {
		const k = 0.6;
		const length = 64;
		const impulse = new Float32Array(length);

		impulse[0] = 1;

		const trajectory = staticTrajectory([k], 8);
		const actual = processLatticeChannel(impulse, trajectory, 1, 1, 8);

		// Closed-form first-order all-pass impulse response:
		//   h[0] = −k ; h[n] = (1 − k²) k^{n−1}  (n ≥ 1)
		const expected = new Float32Array(length);

		expected[0] = -k;

		for (let n = 1; n < length; n++) expected[n] = (1 - k * k) * Math.pow(k, n - 1);

		for (let n = 0; n < length; n++) {
			// f32 storage; the section is algebraically exact, the residual
			// is pure Float32 round-off.
			expect(actual[n]).toBeCloseTo(expected[n] ?? Number.NaN, 5);
		}
	});

	// ── 5F.2: the HONEST lattice identity contract. A kₘ = 0 first-order
	// normalized section is EXACTLY z⁻¹ (a one-sample delay), so an
	// all-kₘ = 0 (identity) trajectory through an order-M lattice is
	// EXACTLY z⁻ᴹ — the input delayed by exactly M samples, NOT a
	// sample-for-sample passthrough. A pure integer M-sample delay is an
	// all-pass: it changes neither the 4× true peak nor the RMS (both
	// shift-invariant), so it is crest-invariant and correct for the
	// node's contract. (Option (b) of 5F.2 — assert the TRUE property, not
	// a false "sample-exact" claim. The node-level strength=0 bit-exact
	// bypass is SEPARATE — the stream never enters the lattice there — and
	// is asserted bit-exact in unit.test.ts; it is unaffected by this.)
	it("an all-zero (identity) trajectory is EXACTLY an M-sample delay (z⁻ᴹ — an all-pass, crest-invariant; NOT sample-exact)", () => {
		const signal = makeDense(4096);
		const trajectory = staticTrajectory(new Array<number>(LATTICE_ORDER).fill(0), 16);
		const output = processLatticeChannel(signal, trajectory, 1, LATTICE_ORDER, 512);

		// 1. Output[n] === Input[n − M] exactly (the cascade of M unit
		//    delays); the first M samples are the zero warm-up.
		for (let index = 0; index < LATTICE_ORDER; index++) {
			expect(output[index]).toBe(0);
		}

		for (let index = LATTICE_ORDER; index < signal.length; index++) {
			// f32 storage; an exact integer-sample delay is algebraically
			// lossless, residual is pure Float32 round-off.
			expect(output[index]).toBeCloseTo(signal[index - LATTICE_ORDER] ?? Number.NaN, 6);
		}

		// 2. It is NOT sample-exact (proves the assertion is the true
		//    property, not a relabelled false "passthrough"): output[M..]
		//    equals input shifted, so output[M] ≠ input[M] for this signal.
		let differsSomewhere = false;

		for (let index = LATTICE_ORDER; index < signal.length; index++) {
			if (Math.abs((output[index] ?? 0) - (signal[index] ?? 0)) > 1e-4) {
				differsSomewhere = true;
				break;
			}
		}

		expect(differsSomewhere).toBe(true);

		// 3. Crest-invariant: equal 4× true peak (to FP) and equal RMS (to
		//    FP) input vs output — a pure bulk delay changes neither, so
		//    the node's true-peak objective is unaffected by the M-sample
		//    identity latency.
		const inputTp = truePeakDb([signal], SAMPLE_RATE);
		const outputTp = truePeakDb([output], SAMPLE_RATE);

		expect(outputTp).toBeCloseTo(inputTp, 4);

		const rms = (s: Float32Array, from: number, to: number): number => {
			let sum = 0;

			for (let index = from; index < to; index++) sum += (s[index] ?? 0) * (s[index] ?? 0);

			return Math.sqrt(sum / (to - from));
		};
		// Interior region (skip the M-sample warm-up edge).
		const ratio = rms(output, 64, signal.length) / rms(signal, 64, signal.length - LATTICE_ORDER);

		expect(ratio).toBeGreaterThan(0.999);
		expect(ratio).toBeLessThan(1.001);
	});
});

describe("processLatticeChannel — losslessness (the Phase-4 Direct-Form-I defect must NOT recur)", () => {
	function rms(signal: Float32Array, from: number, to: number): number {
		let sum = 0;

		for (let index = from; index < to; index++) sum += (signal[index] ?? 0) * (signal[index] ?? 0);

		return Math.sqrt(sum / (to - from));
	}

	it("a STATIC high-order cascade preserves RMS to ~1e-4 (Parseval — exactly all-pass)", () => {
		const signal = makeDense(SAMPLE_RATE);
		// Deliberately large, mixed-sign coefficients (a strong dispersive
		// all-pass — the hardest losslessness case).
		const trajectory = staticTrajectory([0.7, -0.5, 0.85, -0.3, 0.6, -0.75, 0.4, -0.9], 120);
		const output = processLatticeChannel(signal, trajectory, 1, 8, 512);
		// Interior region (avoid the leading/trailing all-pass group-delay
		// edge where the running window is not yet/already filled).
		const ratio = rms(output, 4000, signal.length - 4000) / rms(signal, 4000, signal.length - 4000);

		// Phase-4 Direct-Form-I: RMS NOT preserved (2…25 dB magnitude-null,
		// energy injected at coefficient changes). The normalized lattice
		// is structurally energy-balanced (RMV §IX Eq. 9.10) — RMS is
		// invariant to a tight Float32 bound.
		expect(ratio).toBeGreaterThan(0.999);
		expect(ratio).toBeLessThan(1.001);
	});

	it("a TIME-VARYING cascade (coefficients change every frame) STILL preserves RMS — energy-balanced under time-varying kₘ", () => {
		const signal = makeDense(SAMPLE_RATE);
		const trajectory = timeVaryingTrajectory(8, 120);
		const output = processLatticeChannel(signal, trajectory, 1, 8, 512);
		const ratio = rms(output, 4000, signal.length - 4000) / rms(signal, 4000, signal.length - 4000);

		// The load-bearing claim: the per-section Givens map is orthogonal
		// EVERY sample regardless of how kₘ changes (RMV §IX Eq. 9.8 ⇒
		// 9.10), so RMS stays invariant even when the coefficients move
		// every single frame — the exact failure mode Phase-4 hit.
		expect(ratio).toBeGreaterThan(0.99);
		expect(ratio).toBeLessThan(1.01);
		expect(Number.isFinite(ratio)).toBe(true);
	});

	it("output is finite for extreme (clamped) coefficients — never blows up", () => {
		const signal = makeDense(8192);
		const trajectory = staticTrajectory(new Array<number>(8).fill(5), 16); // |k| ≫ 1, clamped internally
		const output = processLatticeChannel(signal, trajectory, 1, 8, 512);

		for (const value of output) expect(Number.isFinite(value)).toBe(true);
	});
});

describe("extractLatticeTrajectory — the grounded Abel & Smith fit is non-degenerate (5F.1)", () => {
	it("produces a real, fixed-length reflection-coefficient trajectory with at least some non-identity frames on dense content", () => {
		const signal = makeDense(SAMPLE_RATE);
		const analysis = extractLatticeTrajectory([signal], signal, 2048, 512);

		expect(analysis.frameCount).toBeGreaterThan(0);
		expect(analysis.order).toBe(LATTICE_ORDER);
		expect(analysis.trajectory.laneCount).toBe(LATTICE_ORDER);

		for (const row of analysis.trajectory.rows) {
			expect(row.length).toBe(LATTICE_ORDER);

			for (const coefficient of row) {
				expect(Number.isFinite(coefficient)).toBe(true);
				// RMV §III: a stable D(z) steps down to |kₘ| < 1 — the 5F.1
				// escalation gate (the Abel & Smith fit MUST map to a stable
				// normalized-lattice reflection set).
				expect(Math.abs(coefficient)).toBeLessThan(1);
			}
		}

		// Non-degeneracy of the FIT itself: the dense fixture is genuinely
		// dispersive, so the Abel & Smith design must select a real
		// (non-identity) all-pass on at least some frames. (Whole-signal
		// efficacy / never-worsen is asserted at the node level — this
		// guards only that the fit is not a trivial all-zero map.)
		let nonZeroCoefficients = 0;

		for (const row of analysis.trajectory.rows) {
			for (const coefficient of row) {
				if (Math.abs(coefficient) > 1e-4) nonZeroCoefficients += 1;
			}
		}

		expect(nonZeroCoefficients).toBeGreaterThan(0); // NOT a degenerate identity
	});

	it("a diffuse (low-crest) signal maps toward identity (the principled peak-priority outcome)", () => {
		// A pure sine has crest ≈ √2 — no coincident-peak headroom; the
		// peak-priority amount → ≈0 ⇒ the fit is ≈identity (a correct,
		// expected outcome, design §Current Design / FUNDAMENTAL REFRAME).
		const sine = new Float32Array(SAMPLE_RATE);

		for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.5;

		const analysis = extractLatticeTrajectory([sine], sine, 2048, 512);
		let maxAbs = 0;

		for (const row of analysis.trajectory.rows) for (const c of row) maxAbs = Math.max(maxAbs, Math.abs(c));

		// Near-identity (well below the dispersive regime) — the principled
		// ≈identity targeting outcome on already-diffuse material.
		expect(maxAbs).toBeLessThan(0.2);
	});
});
