// byte-frozen Gray–Markel/RMV reference; live path is windowed.ts — see design-crest-reduce item 8.

import { stft, type FftBackend, type StftResult } from "@buffered-audio/utils";
import { designDispersionAllpass, schroederTargetToDelay } from "./dispersion";
import type { ControlTrajectory } from "./trajectory";

// 8 cascaded lattice sections — low order = bounded group delay.
export const LATTICE_ORDER = 8;

// Onset threshold: frame energy exceeding the previous frame's by this ratio flags a transient.
const TRANSIENT_ENERGY_RATIO = 2.0;

// RMV §III |k|<1 stability clamp; kept in sync with dispersion.ts MAX_POLE_RADIUS.
const MAX_REFLECTION = 0.95;

export interface LatticeAnalysis {
	readonly trajectory: ControlTrajectory;
	readonly channelSignals: ReadonlyArray<Float32Array>;
	readonly frameCount: number;
	readonly order: number;
	readonly hopSize: number;
	readonly signalLength: number;
}

// RMV §III Eq. 3.3a/3.3b step-down recursion — see design-crest-reduce item 8 part (c).2.
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

		for (let index = 0; index < mOrder; index++) {
			next[index] = ((current[index] ?? 0) - km * (current[mOrder - index] ?? 0)) / denom;
		}

		next[0] = 1; // structurally exact (a_0 ≡ 1); avoid FP drift
		current = next;
	}

	return reflection;
}

// crest→headroom map, project glue (not sourced) — see design-crest-reduce Targeting.
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
	// √2 ≈ 1.414 is a single sine's crest (no headroom); 6 is strongly peaky. Smoothstep between them.
	const CREST_FLOOR = Math.SQRT2;
	const CREST_CEIL = 6;
	const tNorm = Math.max(0, Math.min(1, (crest - CREST_FLOOR) / (CREST_CEIL - CREST_FLOOR)));

	return tNorm * tNorm * (3 - 2 * tNorm);
}

// analysis-only STFT (synthesis is the time-domain lattice, not OLA) — no OLA failure mode; see design-crest-reduce items 1/8/9.
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

// kₘ=0 section is exactly z⁻¹; all-zero cascade = M-sample delay, crest-invariant (not sample-exact) — see design-crest-reduce identity contract.
export function processLatticeChannel(signal: Float32Array, smoothedTrajectory: ControlTrajectory, strength: number, order: number, hopSize: number): Float32Array {
	const length = signal.length;
	const output = new Float32Array(length);
	const rows = smoothedTrajectory.rows;
	const frameCount = rows.length;
	const state = new Float32Array(order);

	for (let sample = 0; sample < length; sample++) {
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
			// Orthogonal first-order normalized all-pass section (RMV Fig. 4(b)): energy-preserving every sample.
			const toDelay = cCoeff * signalValue + kCoeff * delayed; // → next sₘ
			const sectionOut = -kCoeff * signalValue + cCoeff * delayed; // → xₘ₊₁

			state[section] = toDelay;
			signalValue = sectionOut;
		}

		output[sample] = signalValue;
	}

	return output;
}
