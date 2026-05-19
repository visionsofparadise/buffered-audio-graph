/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { fft, type FftWorkspace } from "@buffered-audio/utils";

interface BandMapping {
	readonly binStart: number;
	readonly binEnd: number;
	readonly weightStart: number;
	readonly weightEnd: number;
}

interface FftAddon {
	batchFft(input: Float32Array, fftSize: number, count: number): { re: Float32Array; im: Float32Array };
}

export function computeFrameMagnitudes(
	re: Float32Array,
	im: Float32Array,
	reOffset: number,
	linearBins: number,
	magScale: number,
	outputBins: number,
	bandMappings: ReadonlyArray<BandMapping> | undefined,
	magnitudeBuffer: Float32Array,
): Float32Array {
	const result = new Float32Array(outputBins);

	if (bandMappings) {
		for (let bin = 0; bin < linearBins; bin++) {
			const real = re[reOffset + bin]!;
			const imag = im[reOffset + bin]!;

			magnitudeBuffer[bin] = Math.sqrt(real * real + imag * imag) * magScale;
		}

		for (let band = 0; band < outputBins; band++) {
			const mapping = bandMappings[band];

			if (!mapping) continue;

			let sum = 0;
			let weightSum = 0;

			for (let bin = mapping.binStart; bin <= mapping.binEnd; bin++) {
				let weight = 1;

				if (bin === mapping.binStart) weight = mapping.weightStart;
				else if (bin === mapping.binEnd) weight = mapping.weightEnd;

				sum += magnitudeBuffer[bin]! * weight;
				weightSum += weight;
			}

			result[band] = weightSum > 0 ? sum / weightSum : 0;
		}
	} else {
		for (let bin = 0; bin < outputBins; bin++) {
			const real = re[reOffset + bin]!;
			const imag = im[reOffset + bin]!;

			result[bin] = Math.sqrt(real * real + imag * imag) * magScale;
		}
	}

	return result;
}

export function computeSpectrogramFrames(
	samples: Float32Array,
	batchFrames: number,
	fftSize: number,
	hopSize: number,
	linearBins: number,
	magScale: number,
	outputBins: number,
	windowCoefficients: Float32Array,
	workspace: FftWorkspace | undefined,
	addon: FftAddon | null,
	bandMappings: ReadonlyArray<BandMapping> | undefined,
	magnitudeBuffer: Float32Array,
): ReadonlyArray<Float32Array> {
	const frames: Array<Float32Array> = [];

	if (addon) {
		const batchInput = new Float32Array(fftSize * batchFrames);

		for (let fi = 0; fi < batchFrames; fi++) {
			const offset = fi * hopSize;
			const destOffset = fi * fftSize;

			for (let si = 0; si < fftSize; si++) {
				batchInput[destOffset + si] = samples[offset + si]! * windowCoefficients[si]!;
			}
		}

		const { re: batchRe, im: batchIm } = addon.batchFft(batchInput, fftSize, batchFrames);

		for (let fi = 0; fi < batchFrames; fi++) {
			frames.push(computeFrameMagnitudes(batchRe, batchIm, fi * linearBins, linearBins, magScale, outputBins, bandMappings, magnitudeBuffer));
		}
	} else {
		const windowed = new Float32Array(fftSize);

		for (let fi = 0; fi < batchFrames; fi++) {
			const offset = fi * hopSize;

			for (let si = 0; si < fftSize; si++) {
				windowed[si] = samples[offset + si]! * windowCoefficients[si]!;
			}

			const { re, im } = fft(windowed, workspace);

			frames.push(computeFrameMagnitudes(re, im, 0, linearBins, magScale, outputBins, bandMappings, magnitudeBuffer));
		}
	}

	return frames;
}
