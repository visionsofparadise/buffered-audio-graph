import { istft, stft } from "@buffered-audio/utils";

const FFT_SIZE = 4096;
const HOP_SIZE = 1024;

/** OLA synthesis weight: a triangular window over `segmentSamples`, each half raised to `transitionPower`, mirrored about the midpoint. */
export function buildTriangularWeight(segmentSamples: number, transitionPower: number): Float32Array {
	const weight = new Float32Array(segmentSamples);
	const half = segmentSamples / 2;

	for (let index = 0; index < half; index++) weight[index] = Math.pow((index + 1) / half, transitionPower);
	for (let index = 0; index < half; index++) weight[segmentSamples - 1 - index] = weight[index] ?? 0;

	return weight;
}

export function reflectPad(signal: Float32Array, padLeft: number, padRight: number, totalLen: number): Float32Array {
	const result = new Float32Array(totalLen);

	result.set(signal, padLeft);

	for (let index = 0; index < padLeft; index++) {
		result[padLeft - 1 - index] = result[padLeft + index] ?? 0;
	}

	const signalEnd = padLeft + signal.length - 1;

	for (let index = 0; index < padRight; index++) {
		result[signalEnd + index + 1] = result[signalEnd - index] ?? 0;
	}

	return result;
}

export interface ComplexStft {
	real: Array<Float32Array>;
	imag: Array<Float32Array>;
}

export function computeStftScaled(signal: Float32Array): ComplexStft {
	const scale = 1 / Math.sqrt(FFT_SIZE);
	const result = stft(signal, FFT_SIZE, HOP_SIZE);
	const halfSize = FFT_SIZE / 2 + 1;
	const real: Array<Float32Array> = new Array<Float32Array>(result.frames);
	const imag: Array<Float32Array> = new Array<Float32Array>(result.frames);

	for (let frame = 0; frame < result.frames; frame++) {
		const frameOffset = frame * halfSize;
		const reFrame = new Float32Array(halfSize);
		const imFrame = new Float32Array(halfSize);

		for (let bin = 0; bin < halfSize; bin++) {
			reFrame[bin] = (result.real[frameOffset + bin] ?? 0) * scale;
			imFrame[bin] = (result.imag[frameOffset + bin] ?? 0) * scale;
		}

		real[frame] = reFrame;
		imag[frame] = imFrame;
	}

	return { real, imag };
}

export function computeIstftScaled(real: Array<Float32Array>, imag: Array<Float32Array>, outputLength: number): Float32Array {
	const scale = Math.sqrt(FFT_SIZE);
	const frames = real.length;
	const halfSize = FFT_SIZE / 2 + 1;
	const contiguousReal = new Float32Array(frames * halfSize);
	const contiguousImag = new Float32Array(frames * halfSize);

	for (let frame = 0; frame < frames; frame++) {
		const reFrame = real[frame];
		const imFrame = imag[frame];

		if (!reFrame || !imFrame) continue;

		const frameOffset = frame * halfSize;

		for (let bin = 0; bin < halfSize; bin++) {
			contiguousReal[frameOffset + bin] = (reFrame[bin] ?? 0) * scale;
			contiguousImag[frameOffset + bin] = (imFrame[bin] ?? 0) * scale;
		}
	}

	return istft({ real: contiguousReal, imag: contiguousImag, frames, fftSize: FFT_SIZE }, HOP_SIZE, outputLength);
}
