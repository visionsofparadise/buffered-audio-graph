// eslint-disable-next-line comment-rules/no-restricted-comments
// Item 7 = Hong, Kim & Har 2011 §2.2/§3 Eqs. 1,5–9 — see design-crest-reduce.md 2026-05-16 grounding catalog pass (the Item-7 search rule).

import { TruePeakUpsampler } from "@buffered-audio/utils";
import { LATTICE_ORDER } from "./lattice";

export const GROUP_DELAY_CEILING_MS = 4.0;

export const SEARCH_GRID_POINTS = 64;

export const SEARCH_REFINE_ITERS = 20;

export const TARGET_PEAK_POWER_RATIO = 0.5;

export function groupDelayLambda(sampleRate: number, order: number = LATTICE_ORDER): number {
	if (order <= 0 || !(sampleRate > 0)) return 0;

	const ceilingSamples = (GROUP_DELAY_CEILING_MS / 1000) * sampleRate;
	const ratio = ceilingSamples / order;

	if (!(ratio > 1)) return 0;

	// eslint-disable-next-line comment-rules/no-restricted-comments
	// λ = (R−1)/(R+1) from Abel & Smith Eq. 4 inverted.
	return (ratio - 1) / (ratio + 1);
}

export function applyWindowAtScale(window: Float32Array, reflectionRow: Float32Array, scale: number, order: number): Float32Array {
	const length = window.length;
	const output = new Float32Array(length);
	const state = new Float32Array(order);
	const MAX_REFLECTION = 0.95;

	for (let sample = 0; sample < length; sample++) {
		let signalValue = window[sample] ?? 0;

		for (let section = 0; section < order; section++) {
			let kCoeff = scale * (reflectionRow[section] ?? 0);

			if (kCoeff > MAX_REFLECTION) kCoeff = MAX_REFLECTION;
			else if (kCoeff < -MAX_REFLECTION) kCoeff = -MAX_REFLECTION;

			const cCoeff = Math.sqrt(Math.max(0, 1 - kCoeff * kCoeff));
			const delayed = state[section] ?? 0;
			// eslint-disable-next-line comment-rules/no-restricted-comments
			// Orthogonal first-order normalized all-pass section (RMV Fig. 4(b)) — energy-preserving every sample.
			const toDelay = cCoeff * signalValue + kCoeff * delayed;
			const sectionOut = -kCoeff * signalValue + cCoeff * delayed;

			state[section] = toDelay;
			signalValue = sectionOut;
		}

		output[sample] = signalValue;
	}

	return output;
}


export function truePeakPower4x(channelWindows: ReadonlyArray<Float32Array>, reflectionRow: Float32Array, scale: number, order: number): number {
	let maxAbs = 0;

	for (const channelWindow of channelWindows) {
		if (channelWindow.length === 0) continue;

		const transformed = applyWindowAtScale(channelWindow, reflectionRow, scale, order);
		const upsampler = new TruePeakUpsampler(4);
		const upsampled = upsampler.upsample(transformed);

		for (let index = 0; index < upsampled.length; index++) {
			const value = upsampled[index] ?? 0;
			const magnitude = value < 0 ? -value : value;

			if (magnitude > maxAbs) maxAbs = magnitude;
		}

		const tail = upsampler.flush();

		for (let index = 0; index < tail.length; index++) {
			const value = tail[index] ?? 0;
			const magnitude = value < 0 ? -value : value;

			if (magnitude > maxAbs) maxAbs = magnitude;
		}
	}

	// eslint-disable-next-line comment-rules/no-restricted-comments
	// |truePeak|² — a POWER, matching Hong's Eq. 5 |p̃(n_i)|² cost shape.
	return maxAbs * maxAbs;
}

export interface SearchResult {
	readonly scale: number;
	readonly iterations: number;
	readonly committedPeakPower: number;
	readonly identityPeakPower: number;
	readonly skippedAlreadyMet: boolean;
}

export function searchBindingPeak(
	channelWindows: ReadonlyArray<Float32Array>,
	reflectionRow: Float32Array,
	order: number,
	lambda: number,
	targetPeakRatio: number = TARGET_PEAK_POWER_RATIO,
): SearchResult {
	const identityPower = truePeakPower4x(channelWindows, reflectionRow, 0, order);
	const targetPeakPower = Math.max(0, targetPeakRatio) * identityPower;

	// eslint-disable-next-line comment-rules/no-restricted-comments
	// Hong 2011 §3 c₀=0 skip-if-already-met: fires only when identity already meets the (window-relative) target.
	if (identityPower <= targetPeakPower || lambda <= 0) {
		return {
			scale: 0,
			iterations: 1,
			committedPeakPower: identityPower,
			identityPeakPower: identityPower,
			skippedAlreadyMet: true,
		};
	}

	let bestScale = 0;
	let bestPeak = identityPower;
	let evaluations = 1;

	const evalAt = (candidate: number): number => {
		evaluations += 1;

		return truePeakPower4x(channelWindows, reflectionRow, candidate, order);
	};

	for (let gridIndex = 1; gridIndex <= SEARCH_GRID_POINTS; gridIndex++) {
		const candidate = (lambda * gridIndex) / SEARCH_GRID_POINTS;
		const power = evalAt(candidate);

		if (power < bestPeak) {
			bestPeak = power;
			bestScale = candidate;
		}
	}

	const step = lambda / SEARCH_GRID_POINTS;
	let lo = Math.max(0, bestScale - step);
	let hi = Math.min(lambda, bestScale + step);

	if (hi > lo) {
		const invPhi = (Math.sqrt(5) - 1) / 2;
		let x1 = hi - invPhi * (hi - lo);
		let x2 = lo + invPhi * (hi - lo);
		let f1 = evalAt(x1);
		let f2 = evalAt(x2);

		for (let iter = 0; iter < SEARCH_REFINE_ITERS; iter++) {
			if (f1 <= f2) {
				hi = x2;
				x2 = x1;
				f2 = f1;
				x1 = hi - invPhi * (hi - lo);
				f1 = evalAt(x1);
			} else {
				lo = x1;
				x1 = x2;
				f1 = f2;
				x2 = lo + invPhi * (hi - lo);
				f2 = evalAt(x2);
			}
		}

		const refinedScale = f1 <= f2 ? x1 : x2;
		const refinedPower = Math.min(f1, f2);

		if (refinedPower < bestPeak) {
			bestPeak = refinedPower;
			bestScale = refinedScale;
		}
	}

	return {
		scale: bestScale,
		iterations: evaluations,
		committedPeakPower: bestPeak,
		identityPeakPower: identityPower,
		skippedAlreadyMet: false,
	};
}
