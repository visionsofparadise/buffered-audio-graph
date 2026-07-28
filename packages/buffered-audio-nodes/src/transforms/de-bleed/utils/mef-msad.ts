/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loops with bounds-checked typed array access */

/**
 * @see Meyer-Elshamy-Fingscheidt 2020; Martin 2001.
 */

import type { KalmanState } from "./mef-kalman";

// eslint-disable-next-line comment-rules/no-restricted-comments
// MEF Table 1 hyperparameters (Eqs. 32,33,35,36,37)
const SNR_THRESHOLD = 0.25;
const ALPHA = Number(process.env.DEBLEED_MSAD_ALPHA) || 0.1;
const MSAD_THRESHOLD = Number(process.env.DEBLEED_MSAD_THETA) || 0.2;
const NOISE_OVERESTIMATION = 4;
const BAND_COUNT = 10;
const PSD_SMOOTHING = Number(process.env.DEBLEED_MSAD_BETA_PSD) || 0.5;

// eslint-disable-next-line comment-rules/no-restricted-comments
// Minimum Statistics tracker constants (Martin 2001).
const MS_SUBWINDOW_COUNT = 8;
const MS_FRAMES_PER_SUBWINDOW = 12;
const MS_BIAS_CORRECTION = 2.0;
const MS_INITIAL_NOISE = 1e-8;

interface MinimumStatisticsState {
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
		// eslint-disable-next-line comment-rules/no-restricted-comments
		// Eq. 32, per MEF §4.1
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

// eslint-disable-next-line comment-rules/no-restricted-comments
// SPR per MEF Eq. 31; sign test per Eq. 33
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

	for (let chIdx = 0; chIdx < channelCount; chIdx++) {
		const state = channelStates[chIdx]!;

		updateSmoothedPsd(state, channelReals[chIdx]!, channelImags[chIdx]!);
		updateNoisePsd(state.noiseTracker, state.smoothedPsd);
	}

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

		if (maxChannel >= 0 && maxValue > 0) {
			sprMasks[maxChannel]![bin] = 1;
		}
	}

	const decisions = new Array<boolean>(channelCount);

	for (let chIdx = 0; chIdx < channelCount; chIdx++) {
		decisions[chIdx] = computeChannelDecision(
			channelReals[chIdx]!,
			channelImags[chIdx]!,
			channelStates[chIdx]!.smoothedPsd,
			channelStates[chIdx]!.noiseTracker.noisePsd,
			sprMasks[chIdx]!,
			numBins,
		);
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

export function applyIspRestoration(
	kalmanState: KalmanState,
	ispState: IspState,
	referenceActive: boolean,
	thresholdFrames: number,
): void {
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
