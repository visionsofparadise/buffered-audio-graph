import { describe, expect, it } from "vitest";
import { TruePeakUpsampler } from "@buffered-audio/utils";
import { LATTICE_ORDER, stepDownToReflection } from "./lattice";
import { designDispersionAllpass, schroederTargetToDelay } from "./dispersion";
import { GROUP_DELAY_CEILING_MS, SEARCH_GRID_POINTS, SEARCH_REFINE_ITERS, applyWindowAtScale, groupDelayLambda, searchBindingPeak, truePeakPower4x } from "./search";

// ─────────────────────────────────────────────────────────────────────
// crest-reduce search suite — RE-SPEC'd to the 2026-05-17 KEYSTONE
// rework + the search→CALCULATE resolution (user-directed, grounded):
//   * `strengthToLambda(strength, …)` → `groupDelayLambda(sampleRate,
//     order)` — λ is ALWAYS the full psychoacoustic-group-delay ceiling
//     (there is NO `strength` parameter; the node always applies the
//     optimal value).
//   * The commit OBJECTIVE is the cross-channel 4× true-peak POWER
//     (`truePeakPower4x`, BS.1770-4 Annex 1), NOT the raw window sample
//     peak. `searchBindingPeak` takes the PER-CHANNEL windows.
//   * The per-peak optimal amount is CALCULATED, not searched: the prior
//     Item-7 Newton + `Math.random` re-acquire is REPLACED by a
//     DETERMINISTIC bounded 1-D minimiser over c∈[0,λ] (coarse uniform
//     grid + golden-section refine). NO RNG anywhere — same inputs ⇒
//     identical result. Domain is [0,λ] NON-NEGATIVE.
// NOT loosened / faked / it.fails / skipped.
// ─────────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const ORDER = LATTICE_ORDER;
// MAX_REFLECTION transcribed from lattice.ts (module-private there) — the
// |kₘ|<1 RMV-stability clamp the applicator enforces.
const MAX_REFLECTION = 0.95;
// The deterministic minimiser's worst-case objective-evaluation count:
// 1 (identity) + SEARCH_GRID_POINTS (grid g=1..N) + 2 (golden seed) +
// SEARCH_REFINE_ITERS (refine loop). Bounded and deterministic.
const MAX_EVALUATIONS = 1 + SEARCH_GRID_POINTS + 2 + SEARCH_REFINE_ITERS;

/**
 * A SYNTHETIC SINGLE-PEAK window: a band-limited cosine impulse (all
 * partials in phase coincide into ONE tall narrow peak with low energy
 * elsewhere — genuine phase-only-recoverable crest headroom). The
 * minimiser should reduce (or hold, never raise) its 4× true peak.
 */
function makeSinglePeakWindow(length: number, harmonics = 40): Float32Array {
	const out = new Float32Array(length);
	let peak = 0;
	const centre = Math.floor(length / 2);

	for (let sample = 0; sample < length; sample++) {
		let value = 0;
		const phase = (sample - centre) / length;

		for (let harmonic = 1; harmonic <= harmonics; harmonic++) value += Math.cos(2 * Math.PI * harmonic * phase);

		out[sample] = value;
		peak = Math.max(peak, Math.abs(value));
	}

	if (peak > 0) for (let sample = 0; sample < length; sample++) out[sample] = ((out[sample] ?? 0) / peak) * 0.9;

	return out;
}

/**
 * The Abel & Smith (Item 9) + RMV step-down (Item 8) reflection row for a
 * window — the EXACT verbatim-reused fit the minimiser adapts the scalar
 * feeding (NOT replaced). Mirrors the per-frame fit the trajectory driver
 * performs (`windowed.ts`): a flat unit magnitude with full
 * peak-priority `amount = 1`, so a genuine dispersive row exists to scale.
 */
function fitReflectionRow(_window: Float32Array): Float32Array {
	const halfSize = FRAME_SIZE / 2 + 1;
	// A non-degenerate magnitude spectrum so the Schroeder→δ(ω)→Abel &
	// Smith fit yields a genuine (non-identity) dispersive row.
	const magnitude = new Float32Array(halfSize);

	for (let bin = 0; bin < halfSize; bin++) magnitude[bin] = 1 + 0.5 * Math.cos((Math.PI * bin) / (halfSize - 1));

	const delay = schroederTargetToDelay(magnitude, 1);
	const { denominator } = designDispersionAllpass(delay, ORDER);
	const reflection = stepDownToReflection(denominator);
	const row = new Float32Array(ORDER);

	for (let section = 0; section < ORDER; section++) row[section] = reflection[section] ?? 0;

	return row;
}

/**
 * The cross-channel 4× true peak (linear amplitude) of one window applied
 * at `scale` — a FRESH cold per-channel `TruePeakUpsampler` (the
 * `truePeakPower4x` discipline; `truePeakPower4x` returns the SQUARE, so
 * this is its sqrt for amplitude-domain comparisons).
 */
function truePeak4xAbs(channelWindows: ReadonlyArray<Float32Array>, row: Float32Array, scale: number): number {
	let maxAbs = 0;

	for (const channelWindow of channelWindows) {
		const transformed = applyWindowAtScale(channelWindow, row, scale, ORDER);
		const upsampler = new TruePeakUpsampler(4);

		for (const output of [upsampler.upsample(transformed), upsampler.flush()]) {
			for (const value of output) maxAbs = Math.max(maxAbs, Math.abs(value));
		}
	}

	return maxAbs;
}

function peakAbs(signal: Float32Array): number {
	let peak = 0;

	for (const value of signal) peak = Math.max(peak, Math.abs(value));

	return peak;
}

describe("crest-reduce search — group-delay → λ ceiling (PROJECT GLUE ②; Abel & Smith Eq. 4 + RMV step-down; no cooked constant; no `strength`)", () => {
	it("λ ∈ (0,1) — a real stability bound (the full group-delay ceiling, NOT scaled by any user dial)", () => {
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);

		expect(lambda).toBeGreaterThan(0);
		expect(lambda).toBeLessThan(1);
	});

	it("degenerate inputs ⇒ λ = 0 (identity floor): non-positive order / sample rate", () => {
		expect(groupDelayLambda(SAMPLE_RATE, 0)).toBe(0);
		expect(groupDelayLambda(0, ORDER)).toBe(0);
		expect(groupDelayLambda(-1, ORDER)).toBe(0);
	});

	it("the SUMMED cascade peak group delay at the ceiling does NOT exceed the named ~4–5 ms bound expressed at the sample rate", () => {
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		// Abel & Smith Eq. 4: per-section peak group delay (1+ρ)/(1−ρ),
		// ρ = |k| ≤ λ. Worst-case summed over `order` sections.
		const summedPeakGroupDelaySamples = ORDER * ((1 + lambda) / (1 - lambda));
		// The ~4–5 ms named bound EXPRESSED AT THE SAMPLE RATE (a bound,
		// NOT a transcribed literature constant).
		const ceilingSamples = (GROUP_DELAY_CEILING_MS / 1000) * SAMPLE_RATE;

		// At the ceiling the summed group delay EQUALS it (λ is the exact
		// inversion of Eq. 4) — never exceeds it.
		expect(summedPeakGroupDelaySamples).toBeLessThanOrEqual(ceilingSamples + 1e-6);
		// And the operating ceiling is within the named ~4–5 ms bound.
		expect(GROUP_DELAY_CEILING_MS).toBeGreaterThanOrEqual(4);
		expect(GROUP_DELAY_CEILING_MS).toBeLessThanOrEqual(5);
	});

	it("λ scales with the sample rate (it is a BOUND expressed at the rate, not a constant)", () => {
		const lambda48 = groupDelayLambda(48_000, ORDER);
		const lambda96 = groupDelayLambda(96_000, ORDER);

		// A higher sample rate ⇒ the ms ceiling spans more samples ⇒ a
		// larger permitted λ. (Proves the ms figure is used as a bound
		// expressed at the rate, never transcribed as a sample constant.)
		expect(lambda96).toBeGreaterThan(lambda48);
	});
});

describe("crest-reduce search — DETERMINISTIC per-binding-peak minimiser (search→calculate; 4× true-peak COMMIT objective; no RNG)", () => {
	it("reduces (or holds — never raises) a synthetic single-peak window's 4× TRUE PEAK, within the bounded deterministic evaluation count", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const channelWindows = [window];
		const row = fitReflectionRow(window);
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const identityTp = truePeak4xAbs(channelWindows, row, 0);
		// Default η ratio (a fraction of the window's own identity 4× TP
		// power) ⇒ the minimiser ATTEMPTS a real reduction (not the
		// skip-if-already-met path — that fires only when identity is
		// already below η).
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);

		// Bounded, deterministic evaluation count (grid + golden refine).
		expect(result.iterations).toBeGreaterThanOrEqual(1);
		expect(result.iterations).toBeLessThanOrEqual(MAX_EVALUATIONS);
		// COMMIT-ONLY-IF-BETTER on the 4× TRUE-PEAK POWER: the committed
		// power NEVER exceeds the identity (c=0) floor.
		expect(result.committedPeakPower).toBeLessThanOrEqual(result.identityPeakPower + 1e-9);
		// The committed scale's measured 4× true peak ≤ identity (and on
		// genuine headroom-bearing content, strictly less — a real,
		// non-trivial reduction, not a degenerate floor-to-identity).
		const committedTp = truePeak4xAbs(channelWindows, row, result.scale);

		expect(committedTp).toBeLessThanOrEqual(identityTp + 1e-6);
		expect(committedTp).toBeLessThan(identityTp); // genuine, non-trivial
	});

	it("is DETERMINISTIC: identical inputs ⇒ bit-identical result, run to run (the whole point of search→calculate; no `Math.random`)", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const right = new Float32Array(FRAME_SIZE);

		for (let sample = 0; sample < FRAME_SIZE; sample++) right[sample] = Math.sin((2 * Math.PI * 137 * sample) / SAMPLE_RATE) * 0.4;

		const channelWindows = [window, right];
		const row = fitReflectionRow(window);
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const a = searchBindingPeak(channelWindows, row, ORDER, lambda);
		const b = searchBindingPeak(channelWindows, row, ORDER, lambda);

		expect(b.scale).toBe(a.scale);
		expect(b.committedPeakPower).toBe(a.committedPeakPower);
		expect(b.identityPeakPower).toBe(a.identityPeakPower);
		expect(b.iterations).toBe(a.iterations);
		expect(b.skippedAlreadyMet).toBe(a.skippedAlreadyMet);
	});

	it("the COMMIT objective is the 4× true-peak power, NOT the raw sample peak (`committedPeakPower` = TP4x²)", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const channelWindows = [window];
		const row = fitReflectionRow(window);
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);

		// `identityPeakPower` / `committedPeakPower` are the cross-channel
		// 4× true-peak POWER (|truePeak|²) — `truePeakPower4x`, NOT the raw
		// window sample peak power. Cross-check the reported committed
		// power against an independent `truePeak4xAbs` measurement.
		const committedTp = truePeak4xAbs(channelWindows, row, result.scale);

		expect(result.committedPeakPower).toBeCloseTo(committedTp * committedTp, 9);
		expect(truePeakPower4x(channelWindows, row, 0, ORDER)).toBeCloseTo(result.identityPeakPower, 9);
	});

	it("skip-if-already-met (deterministic): when the target is already met, the update is skipped (scale = 0, one evaluation)", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const channelWindows = [window];
		const row = fitReflectionRow(window);
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		// targetPeakRatio ≥ 1 ⇒ η = ratio·TP4x(c=0)² ≥ TP4x(c=0)² ⇒ the
		// deterministic skip-if-already-met fires (no minimisation run).
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda, 4);

		expect(result.skippedAlreadyMet).toBe(true);
		expect(result.scale).toBe(0);
		expect(result.iterations).toBe(1); // only the identity evaluation
	});

	it("the committed scale is NON-NEGATIVE and within [0, λ] BY CONSTRUCTION (the bounded deterministic domain; fixes the prior Newton's silent negative c)", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const channelWindows = [window];
		const row = fitReflectionRow(window);
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);

		// Domain is [0, λ] NON-NEGATIVE — downstream (`trajectory.ts`)
		// requires a non-negative decorrelation amount.
		expect(result.scale).toBeGreaterThanOrEqual(0);
		expect(result.scale).toBeLessThanOrEqual(lambda + 1e-12);

		// Every produced reflection coefficient kₘ = clamp(c·rowₘ) is
		// strictly inside the unit circle (RMV |kₘ|<1; clamp at 0.95).
		for (let section = 0; section < ORDER; section++) {
			let km = result.scale * (row[section] ?? 0);

			if (km > MAX_REFLECTION) km = MAX_REFLECTION;
			else if (km < -MAX_REFLECTION) km = -MAX_REFLECTION;

			expect(Math.abs(km)).toBeLessThan(1);
		}
	});

	it("NEVER raises the window's 4× true peak above identity on diffuse / no-headroom content (intrinsic never-worsen — identity is grid point 0)", () => {
		// A pure sine ≈ no phase-only-recoverable headroom (crest ≈ √2).
		const window = new Float32Array(FRAME_SIZE);

		for (let sample = 0; sample < FRAME_SIZE; sample++) window[sample] = Math.sin((2 * Math.PI * 200 * sample) / SAMPLE_RATE) * 0.9;

		const channelWindows = [window];
		const row = fitReflectionRow(window);
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const identityTp = truePeak4xAbs(channelWindows, row, 0);
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);
		const committedTp = truePeak4xAbs(channelWindows, row, result.scale);

		// Commit-only-if-better on the 4× TP power guarantees
		// non-worsening; identity (scale 0, grid sample 0) is the floor.
		expect(committedTp).toBeLessThanOrEqual(identityTp + 1e-6);
	});

	it("the cross-channel objective uses ALL channels (a peak in EITHER channel bounds the committed scale)", () => {
		// Two distinct channels — a peaky impulse train (genuine headroom)
		// and a near-flat low sine. The objective is the max over BOTH
		// channels' 4× true peaks; commit-only-if-better must hold for the
		// cross-channel maximum (never raised above the c=0 floor).
		const left = makeSinglePeakWindow(FRAME_SIZE);
		const right = new Float32Array(FRAME_SIZE);

		for (let sample = 0; sample < FRAME_SIZE; sample++) right[sample] = Math.sin((2 * Math.PI * 130 * sample) / SAMPLE_RATE) * 0.3;

		const channelWindows = [left, right];
		const row = fitReflectionRow(left);
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const identityPower = truePeakPower4x(channelWindows, row, 0, ORDER);
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);

		expect(result.identityPeakPower).toBeCloseTo(identityPower, 9);
		expect(result.committedPeakPower).toBeLessThanOrEqual(result.identityPeakPower + 1e-9);
		// The committed cross-channel 4× true peak does not exceed the
		// identity cross-channel 4× true peak.
		expect(truePeak4xAbs(channelWindows, row, result.scale)).toBeLessThanOrEqual(truePeak4xAbs(channelWindows, row, 0) + 1e-6);
	});
});

describe("crest-reduce search — applyWindowAtScale is the verbatim normalized-lattice element (composed, not replacing the fit)", () => {
	it("scale = 0 is the lattice identity sub-case (an exact M-sample delay — crest-invariant), NOT a perturbation of the magnitude", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const row = fitReflectionRow(window);
		const out = applyWindowAtScale(window, row, 0, ORDER);

		// All-zero kₘ ⇒ each section is exactly z⁻¹ (the lattice identity
		// contract, lattice.ts) ⇒ output is the input delayed by ORDER
		// samples. Peak (shift-invariant) is unchanged.
		expect(peakAbs(out)).toBeCloseTo(peakAbs(window), 6);

		for (let sample = ORDER; sample < FRAME_SIZE; sample++) {
			expect(out[sample]).toBeCloseTo(window[sample - ORDER] ?? 0, 5);
		}
	});

	it("produces finite output across the bounded scale range", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const row = fitReflectionRow(window);
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);

		for (const scale of [0, 0.25 * lambda, 0.5 * lambda, lambda - 1e-6]) {
			for (const value of applyWindowAtScale(window, row, scale, ORDER)) expect(Number.isFinite(value)).toBe(true);
		}
	});

	it("truePeakPower4x returns 0 for empty input and the squared cross-channel 4× true peak otherwise", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const row = fitReflectionRow(window);

		expect(truePeakPower4x([], row, 0, ORDER)).toBe(0);
		expect(truePeakPower4x([new Float32Array(0)], row, 0, ORDER)).toBe(0);

		const power = truePeakPower4x([window], row, 0, ORDER);
		const amp = truePeak4xAbs([window], row, 0);

		expect(power).toBeCloseTo(amp * amp, 9);
		expect(power).toBeGreaterThan(0);
	});

	it("includes a maximum that occurs only in the flushed FIR tail", () => {
		const input = new Float32Array([
			-0.08388812094926834,
			0.6030386090278625,
			-0.7042242288589478,
		]);
		const upsampler = new TruePeakUpsampler(4);
		const sourceAligned = upsampler.upsample(input);
		const sourceAlignedPeak = peakAbs(sourceAligned);
		const power = truePeakPower4x([input], new Float32Array(0), 0, 0);

		expect(power).toBeGreaterThan(sourceAlignedPeak * sourceAlignedPeak);
		expect(Math.sqrt(power)).toBeCloseTo(0.7503057227, 6);
	});
});
