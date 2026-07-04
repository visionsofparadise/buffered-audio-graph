/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loop with bounds-checked typed array access */

/**
 * @see Meyer-Elshamy-Fingscheidt 2020; Enzner & Vary 2006.
 */

import type { TransferFunction } from "./cross-spectral";

export interface KalmanState {
	readonly hReal: Float32Array;
	readonly hImag: Float32Array;
	readonly stateVariance: Float32Array;
	readonly measurementVariance: Float32Array;
}

export interface KalmanParams {
	readonly markovForgetting: number;
	readonly temporalSmoothing: number;
	readonly rOverK: number;
}

export function adaptationSpeedToMarkovForgetting(adaptationSpeed: number): number {
	const exponent = Math.pow(2, (adaptationSpeed - 3) / 3);

	return Math.pow(0.998, exponent);
}

export function createKalmanState(numBins: number, seed: TransferFunction): KalmanState {
	const hReal = new Float32Array(numBins);
	const hImag = new Float32Array(numBins);

	hReal.set(seed.real);
	hImag.set(seed.imag);

	const stateVariance = new Float32Array(numBins);
	const measurementVariance = new Float32Array(numBins);

	stateVariance.fill(1);
	measurementVariance.fill(1);

	return { hReal, hImag, stateVariance, measurementVariance };
}

export function kalmanUpdateFrame(
	targetReal: Float32Array,
	targetImag: Float32Array,
	refReals: ReadonlyArray<Float32Array>,
	refImags: ReadonlyArray<Float32Array>,
	states: ReadonlyArray<KalmanState>,
	kalmanParams: KalmanParams,
	outBleedReal: Float32Array,
	outBleedImag: Float32Array,
	targetActive: boolean,
): void {
	const numBins = outBleedReal.length;
	const refCount = states.length;
	const { markovForgetting, temporalSmoothing, rOverK } = kalmanParams;
	const aSquared = markovForgetting * markovForgetting;
	const oneMinusASquared = 1 - aSquared;
	const oneMinusBeta = 1 - temporalSmoothing;

	outBleedReal.fill(0);
	outBleedImag.fill(0);

	for (let refIndex = 0; refIndex < refCount; refIndex++) {
		const state = states[refIndex]!;
		const refReal = refReals[refIndex]!;
		const refImag = refImags[refIndex]!;

		for (let bin = 0; bin < numBins; bin++) {
			const hPrevRe = state.hReal[bin]!;
			const hPrevIm = state.hImag[bin]!;
			const pPrev = state.stateVariance[bin]!;
			const hPrevMagSq = hPrevRe * hPrevRe + hPrevIm * hPrevIm;
			const psiDelta = oneMinusASquared * (hPrevMagSq + pPrev);

			const hPriorRe = markovForgetting * hPrevRe;
			const hPriorIm = markovForgetting * hPrevIm;
			const pPrior = aSquared * pPrev + psiDelta;

			state.hReal[bin] = hPriorRe;
			state.hImag[bin] = hPriorIm;
			state.stateVariance[bin] = pPrior;

			const yReBin = refReal[bin]!;
			const yImBin = refImag[bin]!;
			const dRe = hPriorRe * yReBin - hPriorIm * yImBin;
			const dIm = hPriorRe * yImBin + hPriorIm * yReBin;

			outBleedReal[bin] = outBleedReal[bin]! + dRe;
			outBleedImag[bin] = outBleedImag[bin]! + dIm;
		}
	}

	if (targetActive) {
		return;
	}

	for (let refIndex = 0; refIndex < refCount; refIndex++) {
		const state = states[refIndex]!;
		const refReal = refReals[refIndex]!;
		const refImag = refImags[refIndex]!;

		for (let bin = 0; bin < numBins; bin++) {
			const eRe = targetReal[bin]! - outBleedReal[bin]!;
			const eIm = targetImag[bin]! - outBleedImag[bin]!;

			const yReBin = refReal[bin]!;
			const yImBin = refImag[bin]!;
			const yMagSq = yReBin * yReBin + yImBin * yImBin;
			const pPrior = state.stateVariance[bin]!;

			const eMagSq = eRe * eRe + eIm * eIm;
			const psiNew = temporalSmoothing * state.measurementVariance[bin]! + oneMinusBeta * (eMagSq + rOverK * yMagSq * pPrior);

			const psiSafe = psiNew + 1e-30;
			const kRe = pPrior * yReBin / psiSafe;
			const kIm = pPrior * (-yImBin) / psiSafe;

			const correctionRe = kRe * eRe - kIm * eIm;
			const correctionIm = kRe * eIm + kIm * eRe;

			state.hReal[bin] = state.hReal[bin]! + correctionRe;
			state.hImag[bin] = state.hImag[bin]! + correctionIm;

			// `max(…, 0)` is a non-MEF numerical-safety clamp: finite-precision can make the reduction factor slightly negative when K·Y ≈ 1.
			const kDotY = kRe * yReBin - kIm * yImBin;
			const reductionFactor = 1 - kDotY > 0 ? 1 - kDotY : 0;

			state.stateVariance[bin] = reductionFactor * pPrior;
			state.measurementVariance[bin] = psiNew;
		}
	}
}
