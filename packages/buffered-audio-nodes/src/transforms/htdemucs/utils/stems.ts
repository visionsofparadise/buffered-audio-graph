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

	for (let ch = 0; ch < 2; ch++) {
		const stftCh = ch === 0 ? stftLeft : stftRight;

		for (let freq = 0; freq < xBins; freq++) {
			for (let frame = 0; frame < xFrames; frame++) {
				const realIdx = 2 * ch * xBins * xFrames + freq * xFrames + frame;
				const imagIdx = (2 * ch + 1) * xBins * xFrames + freq * xFrames + frame;
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
		for (let ch = 0; ch < 2; ch++) {
			const xtIndex = source * 2 * segmentLength + ch * segmentLength;

			for (let frame = 0; frame < nbFrames; frame++) {
				freqRealBuffers[frame]?.fill(0);
				freqImagBuffers[frame]?.fill(0);
			}

			if (xOut) {
				const baseOffset = source * 4 * xBins * xFrames;

				for (let freq = 0; freq < xBins; freq++) {
					for (let frame = 0; frame < xFrames; frame++) {
						const realIdx = baseOffset + 2 * ch * xBins * xFrames + freq * xFrames + frame;
						const imagIdx = baseOffset + (2 * ch + 1) * xBins * xFrames + freq * xFrames + frame;
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

				const outIdx = source * 2 + ch;
				const arr = stemOutputs[outIdx];

				if (arr) {
					arr[segmentOffset + index] = (arr[segmentOffset + index] ?? 0) + combined * wt;
				}
			}
		}
	}
}
