/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ByteBoundedCache } from "./byte-bounded-cache";
import type { FftBackend } from "./fft-backend";
import { getFftAddon } from "./fft-backend";

// Radix-2 transforms follow Cooley and Tukey, "An Algorithm for the Machine Calculation of Complex Fourier Series" (1965).
export interface StftResult {
	readonly real: Float32Array;
	readonly imag: Float32Array;
	readonly frames: number;
	readonly fftSize: number;
}

export interface StftOutput {
	readonly real: Float32Array;
	readonly imag: Float32Array;
}

function assertRadix2Size(size: number): void {
	if (!Number.isSafeInteger(size) || size <= 0 || !Number.isInteger(Math.log2(size))) {
		throw new Error(`FFT size must be a positive power-of-two integer, got ${size}`);
	}
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer, got ${value}`);
	}
}

function assertNonnegativeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a nonnegative integer, got ${value}`);
	}
}

export const STFT_BATCH_SCRATCH_BYTES = 8 * 1024 * 1024;

const HANN_WINDOW_CACHE_BYTES = 1024 * 1024;
const TWIDDLE_CACHE_BYTES = 8 * 1024 * 1024;

export function stft(signal: Float32Array, fftSize: number, hopSize: number, output?: StftOutput, backend?: FftBackend, fftAddonOptions?: { vkfftPath?: string; fftwPath?: string }): StftResult {
	assertRadix2Size(fftSize);
	assertPositiveInteger(hopSize, "STFT hopSize");

	const numFrames = signal.length < fftSize ? 0 : Math.floor((signal.length - fftSize) / hopSize) + 1;
	const halfSize = Math.floor(fftSize / 2) + 1;
	const outputLength = halfSize * numFrames;

	if (output !== undefined && (output.real.length < outputLength || output.imag.length < outputLength)) {
		throw new Error(`STFT output capacity must be at least ${outputLength} values per component`);
	}

	if (numFrames <= 0) {
		const real = output?.real ?? new Float32Array(0);
		const imag = output?.imag ?? new Float32Array(0);

		return { real, imag, frames: 0, fftSize };
	}

	const addon = backend ? getFftAddon(backend, fftAddonOptions) : null;
	let slabFrameCapacity = 0;

	if (addon) {
		const bytesPerFrame = Float32Array.BYTES_PER_ELEMENT * (fftSize + 2 * halfSize);

		if (bytesPerFrame > STFT_BATCH_SCRATCH_BYTES) {
			throw new Error(`STFT fftSize ${fftSize} exceeds the ${STFT_BATCH_SCRATCH_BYTES}-byte native scratch budget`);
		}

		slabFrameCapacity = Math.max(1, Math.floor(STFT_BATCH_SCRATCH_BYTES / bytesPerFrame));
	}

	const real = output?.real ?? new Float32Array(outputLength);
	const imag = output?.imag ?? new Float32Array(outputLength);
	const window = hanningWindow(fftSize);

	if (addon) {
		for (let firstFrame = 0; firstFrame < numFrames; firstFrame += slabFrameCapacity) {
			const slabFrames = Math.min(slabFrameCapacity, numFrames - firstFrame);
			const batchInput = new Float32Array(fftSize * slabFrames);

			for (let slabFrame = 0; slabFrame < slabFrames; slabFrame++) {
				const offset = (firstFrame + slabFrame) * hopSize;

				for (let index = 0; index < fftSize; index++) {
					batchInput[slabFrame * fftSize + index] = (signal[offset + index] ?? 0) * (window[index] ?? 0);
				}
			}

			const outputStart = firstFrame * halfSize;
			const outputEnd = outputStart + slabFrames * halfSize;
			const realSlab = real.subarray(outputStart, outputEnd);
			const imagSlab = imag.subarray(outputStart, outputEnd);

			if (typeof addon.batchFftInto === "function") {
				addon.batchFftInto(batchInput, realSlab, imagSlab, fftSize, slabFrames);
			} else {
				const { re: batchReal, im: batchImag } = addon.batchFft(batchInput, fftSize, slabFrames);

				realSlab.set(batchReal.subarray(0, realSlab.length));
				imagSlab.set(batchImag.subarray(0, imagSlab.length));
			}
		}

		return { real, imag, frames: numFrames, fftSize };
	}

	const windowed = new Float32Array(fftSize);
	const workspace = createFftWorkspace(fftSize);

	for (let frame = 0; frame < numFrames; frame++) {
		const offset = frame * hopSize;

		for (let index = 0; index < fftSize; index++) {
			windowed[index] = (signal[offset + index] ?? 0) * (window[index] ?? 0);
		}

		const { re, im } = fft(windowed, workspace);
		const dstOffset = frame * halfSize;

		for (let bin = 0; bin < halfSize; bin++) {
			real[dstOffset + bin] = re[bin] ?? 0;
			imag[dstOffset + bin] = im[bin] ?? 0;
		}
	}

	return { real, imag, frames: numFrames, fftSize };
}

export function istft(result: StftResult, hopSize: number, outputLength: number, backend?: FftBackend, fftAddonOptions?: { vkfftPath?: string; fftwPath?: string }): Float32Array {
	const { real, imag, frames, fftSize } = result;

	assertRadix2Size(fftSize);
	assertPositiveInteger(hopSize, "ISTFT hopSize");
	assertNonnegativeInteger(outputLength, "ISTFT outputLength");
	assertNonnegativeInteger(frames, "ISTFT frames");

	const halfSize = Math.floor(fftSize / 2) + 1;
	const spectrumLength = halfSize * frames;

	if (!Number.isSafeInteger(spectrumLength) || real.length < spectrumLength || imag.length < spectrumLength) {
		throw new Error(`ISTFT spectrum capacity must be at least ${spectrumLength} values per component`);
	}

	const addon = backend ? getFftAddon(backend, fftAddonOptions) : null;
	let slabFrameCapacity = 0;

	if (addon && frames > 0) {
		const bytesPerFrame = Float32Array.BYTES_PER_ELEMENT * fftSize;

		if (bytesPerFrame > STFT_BATCH_SCRATCH_BYTES) {
			throw new Error(`ISTFT fftSize ${fftSize} exceeds the ${STFT_BATCH_SCRATCH_BYTES}-byte native scratch budget`);
		}

		slabFrameCapacity = Math.max(1, Math.floor(STFT_BATCH_SCRATCH_BYTES / bytesPerFrame));
	}

	const window = hanningWindow(fftSize);
	const output = new Float32Array(outputLength);
	const windowSum = new Float32Array(outputLength);

	if (addon && frames > 0) {
		for (let firstFrame = 0; firstFrame < frames; firstFrame += slabFrameCapacity) {
			const slabFrames = Math.min(slabFrameCapacity, frames - firstFrame);
			const spectrumStart = firstFrame * halfSize;
			const spectrumEnd = spectrumStart + slabFrames * halfSize;
			const realSlab = real.subarray(spectrumStart, spectrumEnd);
			const imagSlab = imag.subarray(spectrumStart, spectrumEnd);
			let timeDomainSlab: Float32Array;

			if (typeof addon.batchIfftInto === "function") {
				timeDomainSlab = new Float32Array(fftSize * slabFrames);
				addon.batchIfftInto(realSlab, imagSlab, timeDomainSlab, fftSize, slabFrames);
			} else {
				timeDomainSlab = addon.batchIfft(realSlab, imagSlab, fftSize, slabFrames);
			}

			for (let slabFrame = 0; slabFrame < slabFrames; slabFrame++) {
				const offset = (firstFrame + slabFrame) * hopSize;

				for (let index = 0; index < fftSize; index++) {
					const position = offset + index;

					if (position < outputLength) {
						output[position] = (output[position] ?? 0) + (timeDomainSlab[slabFrame * fftSize + index] ?? 0) * (window[index] ?? 0);
						windowSum[position] = (windowSum[position] ?? 0) + (window[index] ?? 0) * (window[index] ?? 0);
					}
				}
			}
		}
	} else {
		const fullRe = new Float32Array(fftSize);
		const fullIm = new Float32Array(fftSize);
		const workspace = createFftWorkspace(fftSize);

		for (let frame = 0; frame < frames; frame++) {
			const srcOffset = frame * halfSize;

			fullRe.fill(0);
			fullIm.fill(0);

			for (let bin = 0; bin < halfSize; bin++) {
				fullRe[bin] = real[srcOffset + bin] ?? 0;
				fullIm[bin] = imag[srcOffset + bin] ?? 0;
			}

			for (let index = 1; index < halfSize - 1; index++) {
				fullRe[fftSize - index] = real[srcOffset + index] ?? 0;
				fullIm[fftSize - index] = -(imag[srcOffset + index] ?? 0);
			}

			const timeDomain = ifft(fullRe, fullIm, workspace);
			const offset = frame * hopSize;

			for (let index = 0; index < fftSize; index++) {
				const pos = offset + index;

				if (pos < outputLength) {
					output[pos] = (output[pos] ?? 0) + (timeDomain[index] ?? 0) * (window[index] ?? 0);
					windowSum[pos] = (windowSum[pos] ?? 0) + (window[index] ?? 0) * (window[index] ?? 0);
				}
			}
		}
	}

	for (let index = 0; index < outputLength; index++) {
		const ws = windowSum[index] ?? 0;

		if (ws > 1e-8) {
			output[index] = (output[index] ?? 0) / ws;
		}
	}

	return output;
}

const hanningWindowCache = new ByteBoundedCache<string, Float32Array>(HANN_WINDOW_CACHE_BYTES);

// Periodic and symmetric Hann windows follow Harris, "On the Use of Windows for Harmonic Analysis with the Discrete Fourier Transform" (1978).
export function hanningWindow(size: number, periodic = true): Float32Array {
	assertPositiveInteger(size, "Hann window size");

	const key = `${size}:${periodic ? "p" : "s"}`;
	const cached = hanningWindowCache.get(key);

	if (cached) return cached;

	const window = new Float32Array(size);

	if (size === 1) {
		window[0] = 1;
		hanningWindowCache.set(key, window, window.byteLength);

		return window;
	}

	const denominator = periodic ? size : size - 1;

	for (let index = 0; index < size; index++) {
		window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / denominator));
	}

	hanningWindowCache.set(key, window, window.byteLength);

	return window;
}

export interface FftWorkspace {
	re: Float32Array;
	im: Float32Array;
	outRe: Float32Array;
	outIm: Float32Array;
}

export function createFftWorkspace(size: number): FftWorkspace {
	assertRadix2Size(size);

	return {
		re: new Float32Array(size),
		im: new Float32Array(size),
		outRe: new Float32Array(size),
		outIm: new Float32Array(size),
	};
}

export function fft(input: Float32Array, workspace?: FftWorkspace): { re: Float32Array; im: Float32Array } {
	const size = input.length;

	assertRadix2Size(size);
	if (workspace !== undefined) assertWorkspaceCapacity(workspace, size);

	const re = workspace ? workspace.re : new Float32Array(size);
	const im = workspace ? workspace.im : new Float32Array(size);

	re.set(input);

	if (workspace) im.fill(0);

	if (size <= 1) return { re, im };

	bitReverse(re, im, size);
	butterflyStages(re, im, size);

	return { re, im };
}

export function ifft(re: Float32Array, im: Float32Array, workspace?: FftWorkspace): Float32Array {
	const size = re.length;

	assertRadix2Size(size);
	if (im.length !== size) throw new Error(`IFFT real and imaginary lengths must match, got ${size} and ${im.length}`);
	if (workspace !== undefined) assertWorkspaceCapacity(workspace, size);

	const outRe = workspace ? workspace.outRe : Float32Array.from(re);
	const outIm = workspace ? workspace.outIm : new Float32Array(size);

	if (workspace) outRe.set(re);

	for (let index = 0; index < size; index++) {
		outIm[index] = -(im[index] ?? 0);
	}

	bitReverse(outRe, outIm, size);
	butterflyStages(outRe, outIm, size);

	for (let index = 0; index < size; index++) {
		outRe[index] = (outRe[index] ?? 0) / size;
	}

	return outRe;
}

export function bitReverse(re: Float32Array, im: Float32Array, size: number): void {
	assertRadix2Size(size);
	assertComplexCapacity(re, im, size, "bitReverse");

	let rev = 0;

	for (let index = 0; index < size - 1; index++) {
		if (index < rev) {
			const tempRe = re[index]!;
			const tempIm = im[index]!;

			re[index] = re[rev]!;
			im[index] = im[rev]!;
			re[rev] = tempRe;
			im[rev] = tempIm;
		}

		let bit = size >> 1;

		while (bit <= rev) {
			rev -= bit;
			bit >>= 1;
		}

		rev += bit;
	}
}

const twiddleCache = new ByteBoundedCache<number, { re: Float32Array; im: Float32Array }>(TWIDDLE_CACHE_BYTES);

function getTwiddleFactors(size: number): { re: Float32Array; im: Float32Array } {
	let cached = twiddleCache.get(size);

	if (cached) return cached;

	const totalFactors = size - 1;
	const twRe = new Float32Array(totalFactors);
	const twIm = new Float32Array(totalFactors);
	let offset = 0;

	for (let step = 2; step <= size; step *= 2) {
		const halfStep = step / 2;
		const angle = (-2 * Math.PI) / step;

		for (let pair = 0; pair < halfStep; pair++) {
			twRe[offset + pair] = Math.cos(angle * pair);
			twIm[offset + pair] = Math.sin(angle * pair);
		}

		offset += halfStep;
	}

	cached = { re: twRe, im: twIm };

	if (twRe.byteLength > 0) {
		twiddleCache.set(size, cached, twRe.byteLength + twIm.byteLength);
	}

	return cached;
}

export function butterflyStages(re: Float32Array, im: Float32Array, size: number): void {
	assertRadix2Size(size);
	assertComplexCapacity(re, im, size, "butterflyStages");

	const twiddle = getTwiddleFactors(size);
	const twRe = twiddle.re;
	const twIm = twiddle.im;
	let twOffset = 0;

	for (let step = 2; step <= size; step *= 2) {
		const halfStep = step / 2;

		for (let group = 0; group < size; group += step) {
			for (let pair = 0; pair < halfStep; pair++) {
				const wr = twRe[twOffset + pair]!;
				const wi = twIm[twOffset + pair]!;
				const evenIdx = group + pair;
				const oddIdx = group + pair + halfStep;

				const oddRe = re[oddIdx]!;
				const oddIm = im[oddIdx]!;
				const evenRe = re[evenIdx]!;
				const evenIm = im[evenIdx]!;

				const tRe = oddRe * wr - oddIm * wi;
				const tIm = oddRe * wi + oddIm * wr;

				re[oddIdx] = evenRe - tRe;
				im[oddIdx] = evenIm - tIm;
				re[evenIdx] = evenRe + tRe;
				im[evenIdx] = evenIm + tIm;
			}
		}

		twOffset += halfStep;
	}
}

function assertWorkspaceCapacity(workspace: FftWorkspace, size: number): void {
	assertWorkspaceArrayCapacity("re", workspace.re, size);
	assertWorkspaceArrayCapacity("im", workspace.im, size);
	assertWorkspaceArrayCapacity("outRe", workspace.outRe, size);
	assertWorkspaceArrayCapacity("outIm", workspace.outIm, size);
}

function assertWorkspaceArrayCapacity(name: string, values: Float32Array, size: number): void {
	if (values.length < size) {
		throw new Error(`FFT workspace ${name} capacity must be at least ${size}, got ${values.length}`);
	}
}

function assertComplexCapacity(re: Float32Array, im: Float32Array, size: number, operation: string): void {
	if (re.length < size || im.length < size) {
		throw new Error(`${operation} complex-array capacity must be at least ${size}`);
	}
}
