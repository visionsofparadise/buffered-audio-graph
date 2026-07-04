/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loop with bounds-checked typed array access */

/**
 * @see Meyer-Elshamy-Fingscheidt 2020; Spriet, Doclo, Moonen 2010.
 */

// DEBLEED_LAMBDA_DOM / _Y_RES / _S_RES env overrides available; sum-to-one is not enforced.
const LAMBDA_DOM = Number(process.env.DEBLEED_LAMBDA_DOM) || 0.2;
const LAMBDA_Y_RES = Number(process.env.DEBLEED_LAMBDA_Y_RES) || 0.25;
const LAMBDA_S_RES = Number(process.env.DEBLEED_LAMBDA_S_RES) || 0.15;

export interface InterfererPsdState {
	readonly psd: Float32Array;
	readonly prevOutputPsd: Float32Array;
}

export interface MwfParams {
	readonly temporalSmoothing: number;
	readonly oversubtraction: number;
}

// DEBLEED_LAMBDA_SCALE env override available.
const LAMBDA_SCALE = Number(process.env.DEBLEED_LAMBDA_SCALE) || 5.0;

// HF_BOOST / HF_EXPONENT read env with `!== undefined` (not `||`) so an explicit `0` disables the ramp rather than falling through to the default.
const HF_BOOST = process.env.DEBLEED_HF_BOOST !== undefined ? Number(process.env.DEBLEED_HF_BOOST) : 200;
const HF_EXPONENT = process.env.DEBLEED_HF_EXPONENT !== undefined ? Number(process.env.DEBLEED_HF_EXPONENT) : 2;

export function reductionStrengthToOversubtraction(reductionStrength: number): number {
	return LAMBDA_SCALE * reductionStrength;
}

export function createInterfererPsdState(numBins: number): InterfererPsdState {
	return {
		psd: new Float32Array(numBins),
		prevOutputPsd: new Float32Array(numBins),
	};
}

export function updateInterfererPsd(
	bleedTotalReal: Float32Array,
	bleedTotalImag: Float32Array,
	state: InterfererPsdState,
	beta: number,
): void {
	const numBins = state.psd.length;
	const oneMinusBeta = 1 - beta;

	for (let bin = 0; bin < numBins; bin++) {
		const dRe = bleedTotalReal[bin]!;
		const dIm = bleedTotalImag[bin]!;
		const dPow = dRe * dRe + dIm * dIm;

		state.psd[bin] = beta * state.psd[bin]! + oneMinusBeta * dPow;
	}
}

export function computeMwfMask(
	targetReal: Float32Array,
	targetImag: Float32Array,
	bleedTotalReal: Float32Array,
	bleedTotalImag: Float32Array,
	psdState: InterfererPsdState,
	mwfParams: MwfParams,
	epsilon: number,
	outMask: Float32Array,
): void {
	const numBins = outMask.length;
	const lambda = mwfParams.oversubtraction;
	const hfBoost = HF_BOOST;
	const hfExponent = HF_EXPONENT;
	const binDenom = numBins > 1 ? numBins - 1 : 1;

	const phiYY = outMask;

	let sumPhiYY = 0;
	let sumPhiSSPrev = 0;

	for (let bin = 0; bin < numBins; bin++) {
		const diffRe = targetReal[bin]! - bleedTotalReal[bin]!;
		const diffIm = targetImag[bin]! - bleedTotalImag[bin]!;
		const yyVal = diffRe * diffRe + diffIm * diffIm;

		phiYY[bin] = yyVal;
		sumPhiYY += yyVal;
		sumPhiSSPrev += psdState.prevOutputPsd[bin]!;
	}

	const meanPhiYY = sumPhiYY / numBins;
	const meanPhiSSPrev = sumPhiSSPrev / numBins;
	const rmsPhiYY = Math.sqrt(meanPhiYY);
	const rmsPhiSSPrev = Math.sqrt(meanPhiSSPrev);

	for (let bin = 0; bin < numBins; bin++) {
		const yy = phiYY[bin]!;
		const ssPrev = psdState.prevOutputPsd[bin]!;

		const yyActive = Math.sqrt(yy) >= rmsPhiYY;
		const ssPrevActive = Math.sqrt(ssPrev) >= rmsPhiSSPrev;
		const xDom = yyActive && ssPrevActive ? 1 : 0;

		const phiSS = xDom * LAMBDA_DOM * yy + (1 - xDom) * (LAMBDA_Y_RES * yy + LAMBDA_S_RES * ssPrev);
		const phiDD = psdState.psd[bin]!;
		const binNorm = bin / binDenom;
		const lambdaEff = lambda * (1 + hfBoost * Math.pow(binNorm, hfExponent));
		const denom = phiSS + lambdaEff * phiDD + epsilon;

		const wienerGain = denom > 0 ? phiSS / denom : 0;

		outMask[bin] = wienerGain < 1 ? (wienerGain > 0 ? wienerGain : 0) : 1;
	}
}

/**
 * After the final mask has been applied to the target STFT (post-NLM+DFTT
 * smoothing) the resulting `|Ŝ_m(ℓ,k)|²` must be stored into the PSD state
 * so the NEXT frame's `computeMwfMask` can read it as `Φ̂_ŜŜ(ℓ-1,k)` for the
 * dominant-bin construction.
 *
 * `outputReal` / `outputImag` are the masked target STFT for this frame —
 * `Ŝ_m(ℓ,k) = G_final[k] · Y_m(ℓ,k)`.
 *
 * Note that for the streaming chunked architecture this function should be
 * called once per output frame per target channel. The previous-frame PSD
 * is stored on the per-(target channel) `InterfererPsdState`.
 */
export function updatePrevOutputPsd(
	outputReal: Float32Array,
	outputImag: Float32Array,
	state: InterfererPsdState,
): void {
	const numBins = state.prevOutputPsd.length;

	for (let bin = 0; bin < numBins; bin++) {
		const re = outputReal[bin]!;
		const im = outputImag[bin]!;

		state.prevOutputPsd[bin] = re * re + im * im;
	}
}
