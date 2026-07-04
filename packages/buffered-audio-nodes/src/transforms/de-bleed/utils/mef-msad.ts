/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loops with bounds-checked typed array access */

/**
 * @see Meyer-Elshamy-Fingscheidt 2020; Martin 2001.
 */

import type { KalmanState } from "./mef-kalman";

// MEF Table 1 hyperparameters. DEBLEED_MSAD_ALPHA (Eq. 35), DEBLEED_MSAD_THETA (Eq. 37), DEBLEED_MSAD_BETA_PSD are env-overridable for RX-spectral-shape tuning; SNR_THRESHOLD (Eq. 33), NOISE_OVERESTIMATION (Eq. 32), BAND_COUNT (Eq. 36) are fixed MEF.
const SNR_THRESHOLD = 0.25;
const ALPHA = Number(process.env.DEBLEED_MSAD_ALPHA) || 0.1;
const MSAD_THRESHOLD = Number(process.env.DEBLEED_MSAD_THETA) || 0.2;
const NOISE_OVERESTIMATION = 4;
const BAND_COUNT = 10;
const PSD_SMOOTHING = Number(process.env.DEBLEED_MSAD_BETA_PSD) || 0.5;

// Minimum Statistics tracker constants (Martin 2001).
const MS_SUBWINDOW_COUNT = 8;
const MS_FRAMES_PER_SUBWINDOW = 12;
const MS_BIAS_CORRECTION = 2.0;
// Initial PSD floor — small positive value so the min-tracker has a finite starting point (avoids div-by-zero).
const MS_INITIAL_NOISE = 1e-8;

export interface MinimumStatisticsState {
	readonly noisePsd: Float32Array;
	readonly currentMin: Float32Array;
	readonly subwindowMins: Float32Array;
	subwindowIndex: number;
	frameInSubwindow: number;
}

export interface MsadChannelState {
	readonly smoothedPsd: Float32Array;
	readonly noiseTracker: MinimumStatisticsState;
}

export interface MsadFrameDecision {
	readonly targetActive: boolean;
	readonly referenceActive: ReadonlyArray<boolean>;
}

function createMinimumStatisticsState(numBins: number): MinimumStatisticsState {
	const noisePsd = new Float32Array(numBins);
	const currentMin = new Float32Array(numBins);
	const subwindowMins = new Float32Array(MS_SUBWINDOW_COUNT * numBins);

	noisePsd.fill(MS_INITIAL_NOISE);
	currentMin.fill(Infinity);
	subwindowMins.fill(Infinity);

	return {
		noisePsd,
		currentMin,
		subwindowMins,
		subwindowIndex: 0,
		frameInSubwindow: 0,
	};
}

export function createMsadChannelState(numBins: number): MsadChannelState {
	return {
		smoothedPsd: new Float32Array(numBins),
		noiseTracker: createMinimumStatisticsState(numBins),
	};
}

function updateNoisePsd(state: MinimumStatisticsState, smoothedPsd: Float32Array): void {
	const numBins = smoothedPsd.length;

	for (let bin = 0; bin < numBins; bin++) {
		const psd = smoothedPsd[bin]!;

		if (psd < state.currentMin[bin]!) state.currentMin[bin] = psd;
	}

	state.frameInSubwindow++;

	if (state.frameInSubwindow >= MS_FRAMES_PER_SUBWINDOW) {
		const slotOffset = state.subwindowIndex * numBins;

		for (let bin = 0; bin < numBins; bin++) {
			state.subwindowMins[slotOffset + bin] = state.currentMin[bin]!;
			state.currentMin[bin] = Infinity;
		}

		state.subwindowIndex = (state.subwindowIndex + 1) % MS_SUBWINDOW_COUNT;
		state.frameInSubwindow = 0;
	}

	for (let bin = 0; bin < numBins; bin++) {
		let globalMin = state.currentMin[bin]!;

		for (let slot = 0; slot < MS_SUBWINDOW_COUNT; slot++) {
			const slotMin = state.subwindowMins[slot * numBins + bin]!;

			if (slotMin < globalMin) globalMin = slotMin;
		}

		// If still +∞ (no full sub-window completed yet), keep the prior estimate.
		if (Number.isFinite(globalMin)) {
			state.noisePsd[bin] = MS_BIAS_CORRECTION * globalMin;
		}
	}
}

function updateSmoothedPsd(state: MsadChannelState, channelReal: Float32Array, channelImag: Float32Array): void {
	const numBins = state.smoothedPsd.length;
	const oneMinusBeta = 1 - PSD_SMOOTHING;

	for (let bin = 0; bin < numBins; bin++) {
		const re = channelReal[bin]!;
		const im = channelImag[bin]!;
		const power = re * re + im * im;

		state.smoothedPsd[bin] = PSD_SMOOTHING * state.smoothedPsd[bin]! + oneMinusBeta * power;
	}
}

function computeChannelDecision(
	channelReal: Float32Array,
	channelImag: Float32Array,
	smoothedPsd: Float32Array,
	noisePsd: Float32Array,
	sprPositive: Uint8Array,
	numBins: number,
): boolean {
	const xi = new Float32Array(numBins);
	let relevantBinCount = 0;

	for (let bin = 0; bin < numBins; bin++) {
		const re = channelReal[bin]!;
		const im = channelImag[bin]!;
		const yPow = re * re + im * im;
		const noise = noisePsd[bin]!;
		const noiseOver = NOISE_OVERESTIMATION * noise;
		const yPowMinusOver = yPow - noiseOver;
		const yy = smoothedPsd[bin]!;
		const inner = yPowMinusOver < yy ? yPowMinusOver : yy;
		const numerator = inner > 0 ? inner : 0;
		// Eq. 32 uses the OVERESTIMATED noise PSD β_NN·Φ̂_NN (NOT raw Φ̂_NN) throughout, per MEF §4.1.
		const xiBin = noiseOver > 0 ? numerator / noiseOver : 0;

		xi[bin] = xiBin;

		if (sprPositive[bin] === 1 && xiBin >= SNR_THRESHOLD) relevantBinCount++;
	}

	const etaPlus = relevantBinCount / numBins;

	const baseBandSize = Math.floor(numBins / BAND_COUNT);
	let maxBandAvg = 0;

	for (let band = 0; band < BAND_COUNT; band++) {
		const startBin = band * baseBandSize;
		const endBin = band === BAND_COUNT - 1 ? numBins : startBin + baseBandSize;
		const bandSize = endBin - startBin;

		if (bandSize === 0) continue;

		let sum = 0;

		for (let bin = startBin; bin < endBin; bin++) sum += xi[bin]!;

		const bandAvg = sum / bandSize;

		if (bandAvg > maxBandAvg) maxBandAvg = bandAvg;
	}

	const gBin = Math.min(ALPHA * maxBandAvg, 1);

	const phiMsad = gBin * etaPlus;

	return phiMsad > MSAD_THRESHOLD;
}

/**
 * Compute the per-frame MSAD decision across all channels.
 *
 * Inputs: STFT bin values for the target channel and each reference channel
 * for the current frame, plus the per-channel MSAD state objects (smoothed
 * PSD + noise tracker), in the order `[target, ref0, ref1, ...]`.
 *
 * Per MEF Eq. 31 the SPR (signal-power ratio) is a multichannel quantity:
 *
 *   SPR_m(ℓ,k) = 10·log₁₀[ξ_*,m(ℓ,k) / max_μ ξ_*,μ(ℓ,k)]
 *
 * with `ξ_*,m = Φ̂_{YY,m} − Φ̂_{NN,m}` (the cleaned PSD, lower-bounded at 0).
 * SPR > 0 dB picks the channel with the loudest cleaned PSD at bin k —
 * equivalent to "channel m has more signal at bin k than any other channel."
 * Since MEF only checks the SIGN of SPR (Eq. 33: `SPR > 0`), we can skip the
 * log-domain conversion and just check whether channel m's cleaned PSD is
 * the maximum across channels (after a guard for ties).
 *
 * Updates each channel's `smoothedPsd` and `noiseTracker` as a side effect.
 *
 * Returns `{ targetActive, referenceActive: [μ0, μ1, ...] }`.
 */
export function computeMsadDecision(
	channelReals: ReadonlyArray<Float32Array>,
	channelImags: ReadonlyArray<Float32Array>,
	channelStates: ReadonlyArray<MsadChannelState>,
): MsadFrameDecision {
	const channelCount = channelStates.length;

	if (channelCount === 0) {
		return { targetActive: false, referenceActive: [] };
	}

	const numBins = channelStates[0]!.smoothedPsd.length;

	// Step 1: update smoothed PSD + Minimum Statistics noise PSD per channel.
	for (let chIdx = 0; chIdx < channelCount; chIdx++) {
		const state = channelStates[chIdx]!;

		updateSmoothedPsd(state, channelReals[chIdx]!, channelImags[chIdx]!);
		updateNoisePsd(state.noiseTracker, state.smoothedPsd);
	}

	// Step 2: cleaned PSD ξ_*,m = max(Φ̂_YY − Φ̂_NN, 0) per channel per bin.
	// Then per bin, find max-channel — that channel has SPR > 0 dB at bin k.
	const cleanedPsds = new Array<Float32Array>(channelCount);

	for (let chIdx = 0; chIdx < channelCount; chIdx++) {
		const cleaned = new Float32Array(numBins);
		const yy = channelStates[chIdx]!.smoothedPsd;
		const nn = channelStates[chIdx]!.noiseTracker.noisePsd;

		for (let bin = 0; bin < numBins; bin++) {
			const diff = yy[bin]! - nn[bin]!;

			cleaned[bin] = diff > 0 ? diff : 0;
		}

		cleanedPsds[chIdx] = cleaned;
	}

	// Step 3: per channel, build SPR-positive mask (1 iff this channel's
	// cleaned PSD is the strict max across channels at bin k).
	const sprMasks = Array.from({ length: channelCount }, () => new Uint8Array(numBins));

	for (let bin = 0; bin < numBins; bin++) {
		let maxValue = -Infinity;
		let maxChannel = -1;

		for (let chIdx = 0; chIdx < channelCount; chIdx++) {
			const value = cleanedPsds[chIdx]![bin]!;

			if (value > maxValue) {
				maxValue = value;
				maxChannel = chIdx;
			}
		}

		// Strict positivity gate: SPR > 0 dB requires the channel's cleaned PSD
		// to actually exceed the others, AND be > 0 (else cleaned PSD is below
		// the noise floor in every channel — no signal to ratio against).
		if (maxChannel >= 0 && maxValue > 0) {
			sprMasks[maxChannel]![bin] = 1;
		}
	}

	// Step 4: per channel, compute Eqs. 32–37 against its SPR-positive mask.
	const decisions = new Array<boolean>(channelCount);

	for (let chIdx = 0; chIdx < channelCount; chIdx++) {
		decisions[chIdx] = computeChannelDecision(channelReals[chIdx]!, channelImags[chIdx]!, channelStates[chIdx]!.smoothedPsd, channelStates[chIdx]!.noiseTracker.noisePsd, sprMasks[chIdx]!, numBins);
	}

	return {
		targetActive: decisions[0]!,
		referenceActive: decisions.slice(1),
	};
}

export interface IspState {
	readonly storedHReal: Float32Array;
	readonly storedHImag: Float32Array;
	readonly storedP: Float32Array;
	inactiveFrames: number;
	hasStored: boolean;
}

export const ISP_THRESHOLD_FRAMES = 24;

export function createIspState(numBins: number): IspState {
	return {
		storedHReal: new Float32Array(numBins),
		storedHImag: new Float32Array(numBins),
		storedP: new Float32Array(numBins),
		inactiveFrames: 0,
		hasStored: false,
	};
}

export function applyIspRestoration(kalmanState: KalmanState, ispState: IspState, referenceActive: boolean, thresholdFrames: number): void {
	const numBins = kalmanState.hReal.length;

	if (referenceActive) {
		const transitionedToActive = ispState.inactiveFrames >= thresholdFrames && ispState.hasStored;

		if (transitionedToActive) {
			for (let bin = 0; bin < numBins; bin++) {
				kalmanState.hReal[bin] = ispState.storedHReal[bin]!;
				kalmanState.hImag[bin] = ispState.storedHImag[bin]!;
				kalmanState.stateVariance[bin] = ispState.storedP[bin]!;
			}
		} else {
			for (let bin = 0; bin < numBins; bin++) {
				ispState.storedHReal[bin] = kalmanState.hReal[bin]!;
				ispState.storedHImag[bin] = kalmanState.hImag[bin]!;
				ispState.storedP[bin] = kalmanState.stateVariance[bin]!;
			}

			ispState.hasStored = true;
		}

		ispState.inactiveFrames = 0;
	} else {
		ispState.inactiveFrames++;
	}
}
