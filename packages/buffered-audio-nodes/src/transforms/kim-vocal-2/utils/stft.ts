import { hanningWindow, type MixedRadixFft } from "@buffered-audio/utils";

const N_FFT = 7680;
const HOP_SIZE = 1024;
const DIM_F = 3072;
const DIM_T = 256;
const NB_BINS = N_FFT / 2 + 1; // 3841

export function stft7680IntoTensor(fft: MixedRadixFft, signal: Float32Array, tensor: Float32Array, realOffset: number, imagOffset: number): void {
	const win = hanningWindow(N_FFT);
	const windowed = fft.frameRe;
	const zeros = fft.frameIm;

	zeros.fill(0);

	let frame = 0;

	for (let start = 0; start + N_FFT <= signal.length; start += HOP_SIZE) {
		for (let index = 0; index < N_FFT; index++) {
			windowed[index] = (signal[start + index] ?? 0) * (win[index] ?? 0);
		}

		fft.fft(windowed, zeros, fft.outRe, fft.outIm);

		for (let freq = 0; freq < DIM_F; freq++) {
			tensor[realOffset + freq * DIM_T + frame] = fft.outRe[freq] ?? 0;
			tensor[imagOffset + freq * DIM_T + frame] = fft.outIm[freq] ?? 0;
		}

		frame++;
	}
}

export function istft7680FromTensor(fft: MixedRadixFft, tensor: Float32Array, realOffset: number, imagOffset: number, numFrames: number, scale: number, output: Float32Array, windowSum: Float32Array): void {
	const win = hanningWindow(N_FFT);
	const fullRe = fft.frameRe;
	const fullIm = fft.frameIm;
	const outputLength = output.length;

	for (let frame = 0; frame < numFrames; frame++) {
		fullRe.fill(0);
		fullIm.fill(0);

		for (let freq = 0; freq < DIM_F; freq++) {
			fullRe[freq] = (tensor[realOffset + freq * DIM_T + frame] ?? 0) * scale;
			fullIm[freq] = (tensor[imagOffset + freq * DIM_T + frame] ?? 0) * scale;
		}

		for (let index = 1; index < NB_BINS - 1; index++) {
			fullRe[N_FFT - index] = fullRe[index] ?? 0;
			fullIm[N_FFT - index] = -(fullIm[index] ?? 0);
		}

		fft.ifft(fullRe, fullIm, fft.outRe, fft.outIm);

		const frameOffset = frame * HOP_SIZE;

		for (let index = 0; index < N_FFT; index++) {
			const pos = frameOffset + index;

			if (pos < outputLength) {
				const wt = win[index] ?? 0;

				output[pos] = (output[pos] ?? 0) + (fft.outRe[index] ?? 0) * wt;
				windowSum[pos] = (windowSum[pos] ?? 0) + wt * wt;
			}
		}
	}

	for (let index = 0; index < outputLength; index++) {
		const ws = windowSum[index] ?? 0;

		if (ws > 1e-8) {
			output[index] = (output[index] ?? 0) / ws;
		}
	}
}
