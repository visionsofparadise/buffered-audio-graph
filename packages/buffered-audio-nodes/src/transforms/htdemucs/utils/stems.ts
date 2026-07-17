import { computeIstftScaled, type ComplexStft } from "./dsp";

export function buildModelInput(
	segLeft: Float32Array,
	segRight: Float32Array,
	stftLeft: ComplexStft,
	stftRight: ComplexStft,
	segmentLength: number,
	xBins: number,
	xFrames: number,
): { readonly inputData: Float32Array; readonly xData: Float32Array } {
	const xData = new Float32Array(4 * xBins * xFrames);

	for (let channel = 0; channel < 2; channel++) {
		const stftCh = channel === 0 ? stftLeft : stftRight;

		for (let freq = 0; freq < xBins; freq++) {
			for (let frame = 0; frame < xFrames; frame++) {
				const realIdx = 2 * channel * xBins * xFrames + freq * xFrames + frame;
				const imagIdx = (2 * channel + 1) * xBins * xFrames + freq * xFrames + frame;
				const srcFrame = frame + 2;

				xData[realIdx] = stftCh.real[srcFrame]?.[freq] ?? 0;
				xData[imagIdx] = stftCh.imag[srcFrame]?.[freq] ?? 0;
			}
		}
	}

	const inputData = new Float32Array(2 * segmentLength);

	inputData.set(segLeft, 0);
	inputData.set(segRight, segmentLength);

	return { inputData, xData };
}

/**
 * Collapses the 4 stem OLA accumulators (interleaved L/R per stem) into a stereo pair for the first
 * `nStable` samples: normalizes each sample by the OLA `sumWeight`, applies per-stem gains, then
 * de-normalizes with the global `{ mean, std }` used before inference.
 */
export function mixStemsToStereo(
	stemAccum: ReadonlyArray<Float32Array>,
	sumWeight: Float32Array,
	stemGains: ReadonlyArray<number>,
	stats: { readonly mean: number; readonly std: number },
	nStable: number,
): { readonly outLeft: Float32Array; readonly outRight: Float32Array } {
	const outLeft = new Float32Array(nStable);
	const outRight = new Float32Array(nStable);

	for (let index = 0; index < nStable; index++) {
		const sw = sumWeight[index] ?? 1;
		let mixedL = 0;
		let mixedR = 0;

		for (let stem = 0; stem < 4; stem++) {
			const gain = stemGains[stem] ?? 1;

			if (gain === 0) continue;

			const arrL = stemAccum[stem * 2];
			const arrR = stemAccum[stem * 2 + 1];

			if (arrL) mixedL += (sw === 0 ? 0 : (arrL[index] ?? 0) / sw) * gain;
			if (arrR) mixedR += (sw === 0 ? 0 : (arrR[index] ?? 0) / sw) * gain;
		}

		outLeft[index] = mixedL * stats.std + stats.mean;
		outRight[index] = mixedR * stats.std + stats.mean;
	}

	return { outLeft, outRight };
}

export interface StftWorkspace {
	readonly freqRealBuffers: Array<Float32Array>;
	readonly freqImagBuffers: Array<Float32Array>;
	readonly nbFrames: number;
	readonly stftLen: number;
	readonly stftPad: number;
	readonly pad: number;
	readonly xBins: number;
	readonly xFrames: number;
}

export function extractStems(
	xtOut: { readonly data: Float32Array } | undefined,
	xOut: { readonly data: Float32Array } | undefined,
	workspace: StftWorkspace,
	stemOutputs: Array<Float32Array>,
	weight: Float32Array,
	segmentOffset: number,
	chunkLength: number,
	segmentLength: number,
): void {
	const { freqRealBuffers, freqImagBuffers, nbFrames, stftLen, stftPad, pad, xBins, xFrames } = workspace;

	for (let source = 0; source < 4; source++) {
		for (let channel = 0; channel < 2; channel++) {
			const xtIndex = source * 2 * segmentLength + channel * segmentLength;

			for (let frame = 0; frame < nbFrames; frame++) {
				freqRealBuffers[frame]?.fill(0);
				freqImagBuffers[frame]?.fill(0);
			}

			if (xOut) {
				const baseOffset = source * 4 * xBins * xFrames;

				for (let freq = 0; freq < xBins; freq++) {
					for (let frame = 0; frame < xFrames; frame++) {
						const realIdx = baseOffset + 2 * channel * xBins * xFrames + freq * xFrames + frame;
						const imagIdx = baseOffset + (2 * channel + 1) * xBins * xFrames + freq * xFrames + frame;
						const destFrame = frame + 2;
						const realArr = freqRealBuffers[destFrame];
						const imagArr = freqImagBuffers[destFrame];

						if (realArr && imagArr) {
							realArr[freq] = xOut.data[realIdx] ?? 0;
							imagArr[freq] = xOut.data[imagIdx] ?? 0;
						}
					}
				}
			}

			const freqWaveform = computeIstftScaled(freqRealBuffers, freqImagBuffers, stftLen);
			const freqOffset = stftPad + pad;

			for (let index = 0; index < chunkLength; index++) {
				const timeVal = xtOut ? (xtOut.data[xtIndex + index] ?? 0) : 0;
				const freqVal = freqWaveform[freqOffset + index] ?? 0;
				const combined = timeVal + freqVal;
				const wt = weight[index] ?? 1;

				const outIdx = source * 2 + channel;
				const stemOutput = stemOutputs[outIdx];

				if (stemOutput) {
					stemOutput[segmentOffset + index] = (stemOutput[segmentOffset + index] ?? 0) + combined * wt;
				}
			}
		}
	}
}
