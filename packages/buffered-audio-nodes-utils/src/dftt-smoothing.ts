/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loop with bounds-checked typed array access */

import { createFftWorkspace, fft, hanningWindow, ifft, type FftWorkspace } from "./stft";
import { getFftAddon, type FftBackend } from "./fft-backend";

// Gain-mask adaptation of Buades, Coll, and Morel, "A Non-Local Algorithm for Image Denoising" (2005), and Lukin and Todd, "Suppression of Musical Noise Artifacts in Audio Noise Reduction by Adaptive 2D Filtering" (2007).
export interface DfttParams {
	/** Block size along the frequency axis (32 bins). */
	readonly blockFreq: number;
	/** Block size along the time axis (16 frames). */
	readonly blockTime: number;
	/** Hop size along the frequency axis (8 bins). */
	readonly hopFreq: number;
	/** Hop size along the time axis (4 frames). */
	readonly hopTime: number;
	/** Wiener noise-floor standard deviation σ in |NLM|² / (|NLM|² + σ²), on the shared user-tuned scale. */
	readonly threshold: number;
}

export interface DfttExecutionOptions {
	readonly maxBatchBytes?: number;
}

const MAX_DFTT_BATCH_BYTES = 32 * 1024 * 1024;

export function getDfttBatchBlockCount(blockSize: number, complexBlockSize: number, maxBatchBytes: number): number {
	if (!Number.isSafeInteger(blockSize) || blockSize <= 0 || !Number.isSafeInteger(complexBlockSize) || complexBlockSize <= 0) {
		throw new Error("DFTT block sizes must be positive integers");
	}

	if (!Number.isFinite(maxBatchBytes) || maxBatchBytes <= 0 || maxBatchBytes > MAX_DFTT_BATCH_BYTES) {
		throw new Error(`DFTT maxBatchBytes must be finite and in (0, ${MAX_DFTT_BATCH_BYTES}]`);
	}

	const bytesPerBlock = Float32Array.BYTES_PER_ELEMENT * (3 * blockSize + 4 * complexBlockSize);

	if (!Number.isSafeInteger(bytesPerBlock)) {
		throw new Error("DFTT block geometry exceeds the safe integer range");
	}

	const blockCount = Math.floor(maxBatchBytes / bytesPerBlock);

	if (blockCount < 1) {
		throw new Error(`One DFTT block requires ${bytesPerBlock} bytes, exceeding the ${maxBatchBytes}-byte batch budget`);
	}

	return blockCount;
}

// Packs two real FFTs into one complex FFT via DFT linearity.
function complexFft(
	inRe: Float32Array,
	inIm: Float32Array,
	outRe: Float32Array,
	outIm: Float32Array,
	workspaceA: FftWorkspace,
	workspaceB: FftWorkspace,
): void {
	const { re: reOfRe, im: imOfRe } = fft(inRe, workspaceA);
	const { re: reOfIm, im: imOfIm } = fft(inIm, workspaceB);
	const size = inRe.length;

	for (let ii = 0; ii < size; ii++) {
		outRe[ii] = reOfRe[ii]! - imOfIm[ii]!;
		outIm[ii] = imOfRe[ii]! + reOfIm[ii]!;
	}
}

function complexIfft(
	inRe: Float32Array,
	inIm: Float32Array,
	outRe: Float32Array,
	outIm: Float32Array,
	negativeReal: Float32Array,
	workspaceA: FftWorkspace,
	workspaceB: FftWorkspace,
): void {
	const realResult = ifft(inRe, inIm, workspaceA);

	outRe.set(realResult);

	for (let index = 0; index < inRe.length; index++) negativeReal[index] = -inRe[index]!;

	const imaginaryResult = ifft(inIm, negativeReal, workspaceB);

	outIm.set(imaginaryResult);
}

function getWienerGain(signalMagnitudeSquared: number, noiseMagnitudeSquared: number): number {
	if (noiseMagnitudeSquared === 0) return signalMagnitudeSquared === 0 ? 0 : 1;

	return signalMagnitudeSquared / (signalMagnitudeSquared + noiseMagnitudeSquared);
}

export interface DfttProfileMs {
	fill: number;
	forward: number;
	gain: number;
	inverse: number;
	ola: number;
	normalize: number;
}

export function applyDfttSmoothing(
	nlmSmoothed: Float32Array,
	rawMask: Float32Array,
	numFrames: number,
	numBins: number,
	dfttOptions: DfttParams,
	output: Float32Array,
	fftBackend: FftBackend | undefined,
	fftAddonOptions: { vkfftPath?: string; fftwPath?: string } | undefined,
	profileMs?: DfttProfileMs,
	executionOptions?: DfttExecutionOptions,
): void {
	const { blockFreq, blockTime, hopFreq, hopTime, threshold } = dfttOptions;
	const maskLength = numFrames * numBins;

	assertPositiveSafeInteger(numFrames, "DFTT numFrames");
	assertPositiveSafeInteger(numBins, "DFTT numBins");

	if (!Number.isSafeInteger(maskLength)) {
		throw new Error("DFTT mask dimensions exceed the safe integer range");
	}

	if (nlmSmoothed.length !== maskLength || rawMask.length !== maskLength || output.length !== maskLength) {
		throw new Error(`DFTT input and output lengths must equal ${maskLength}`);
	}

	assertPowerOfTwo(blockFreq, "DFTT blockFreq");
	assertPowerOfTwo(blockTime, "DFTT blockTime");
	assertPositiveSafeInteger(hopFreq, "DFTT hopFreq");
	assertPositiveSafeInteger(hopTime, "DFTT hopTime");

	if (hopFreq > blockFreq || hopTime > blockTime) {
		throw new Error("DFTT hops must be no larger than their block dimensions");
	}

	if (!Number.isFinite(threshold) || threshold < 0) {
		throw new Error(`DFTT threshold must be finite and nonnegative, got ${threshold}`);
	}

	const blockSize = blockTime * blockFreq;
	const complexBlockSize = blockTime * (Math.floor(blockFreq / 2) + 1);
	const maxBatchBytes = executionOptions?.maxBatchBytes ?? MAX_DFTT_BATCH_BYTES;
	const batchBlockCapacity = getDfttBatchBlockCount(blockSize, complexBlockSize, maxBatchBytes);

	if (threshold === 0) {
		output.set(rawMask);

		return;
	}

	if (typedArraysOverlap(output, rawMask) || typedArraysOverlap(output, nlmSmoothed)) {
		throw new Error("DFTT output must not overlap either input for non-bypass processing");
	}

	const addon = fftBackend ? getFftAddon(fftBackend, fftAddonOptions) : null;

	if (!addon || typeof addon.batchFft2D !== "function" || typeof addon.batchIfft2D !== "function") {
		applyDfttSmoothingJs(nlmSmoothed, rawMask, numFrames, numBins, dfttOptions, output);

		return;
	}

	let profileMark = profileMs ? performance.now() : 0;
	const profileAdd = (key: keyof DfttProfileMs): void => {
		if (!profileMs) return;

		const now = performance.now();

		profileMs[key] += now - profileMark;
		profileMark = now;
	};

	const winFreq = hanningWindow(blockFreq, false);
	const winTime = hanningWindow(blockTime, false);
	const win2d = new Float32Array(blockSize);

	for (let tf = 0; tf < blockTime; tf++) {
		for (let bf = 0; bf < blockFreq; bf++) {
			win2d[tf * blockFreq + bf] = winTime[tf]! * winFreq[bf]!;
		}
	}

	// Block starts and boundary clamping must match the JS path exactly.
	const blocksPerFrame = Math.ceil(numFrames / hopTime);
	const blocksPerBin = Math.ceil(numBins / hopFreq);
	const totalBlocks = blocksPerFrame * blocksPerBin;
	const sigmaSq = threshold * threshold;
	const windowSumSq = new Float32Array(maskLength);

	output.fill(0);

	for (let firstGlobalBlock = 0; firstGlobalBlock < totalBlocks; firstGlobalBlock += batchBlockCapacity) {
		const batchCount = Math.min(batchBlockCapacity, totalBlocks - firstGlobalBlock);
		const rawBatch = new Float32Array(batchCount * blockSize);
		const nlmBatch = new Float32Array(batchCount * blockSize);

		for (let localBlock = 0; localBlock < batchCount; localBlock++) {
			const globalBlock = firstGlobalBlock + localBlock;
			const frameIndex = Math.floor(globalBlock / blocksPerBin);
			const binIndex = globalBlock % blocksPerBin;
			const frameStart = frameIndex * hopTime;
			const binStart = binIndex * hopFreq;
			const blockOffset = localBlock * blockSize;

			for (let tf = 0; tf < blockTime; tf++) {
				const srcFrame = Math.min(frameStart + tf, numFrames - 1);

				for (let bf = 0; bf < blockFreq; bf++) {
					const srcBin = Math.min(binStart + bf, numBins - 1);
					const windowValue = win2d[tf * blockFreq + bf]!;
					const sourcePosition = srcFrame * numBins + srcBin;
					const batchPosition = blockOffset + tf * blockFreq + bf;

					rawBatch[batchPosition] = rawMask[sourcePosition]! * windowValue;
					nlmBatch[batchPosition] = nlmSmoothed[sourcePosition]! * windowValue;
				}
			}
		}

		profileAdd("fill");

		const rawFft = addon.batchFft2D(rawBatch, blockTime, blockFreq, batchCount);
		const nlmFft = addon.batchFft2D(nlmBatch, blockTime, blockFreq, batchCount);
		const batchComplexLength = batchCount * complexBlockSize;

		assertArrayLength(rawFft.re, batchComplexLength, "DFTT addon raw real output");
		assertArrayLength(rawFft.im, batchComplexLength, "DFTT addon raw imaginary output");
		assertArrayLength(nlmFft.re, batchComplexLength, "DFTT addon NLM real output");
		assertArrayLength(nlmFft.im, batchComplexLength, "DFTT addon NLM imaginary output");
		profileAdd("forward");

		for (let flatIndex = 0; flatIndex < batchComplexLength; flatIndex++) {
			const nlmReal = nlmFft.re[flatIndex]!;
			const nlmImaginary = nlmFft.im[flatIndex]!;
			const nlmMagnitudeSquared = nlmReal * nlmReal + nlmImaginary * nlmImaginary;
			const gain = getWienerGain(nlmMagnitudeSquared, sigmaSq);

			rawFft.re[flatIndex] = rawFft.re[flatIndex]! * gain;
			rawFft.im[flatIndex] = rawFft.im[flatIndex]! * gain;
		}

		profileAdd("gain");

		const synth = addon.batchIfft2D(rawFft.re, rawFft.im, blockTime, blockFreq, batchCount);

		assertArrayLength(synth, batchCount * blockSize, "DFTT addon inverse output");
		profileAdd("inverse");

		for (let localBlock = 0; localBlock < batchCount; localBlock++) {
			const globalBlock = firstGlobalBlock + localBlock;
			const frameIndex = Math.floor(globalBlock / blocksPerBin);
			const binIndex = globalBlock % blocksPerBin;
			const frameStart = frameIndex * hopTime;
			const binStart = binIndex * hopFreq;
			const blockOffset = localBlock * blockSize;

			for (let tf = 0; tf < blockTime; tf++) {
				const destinationFrame = frameStart + tf;

				if (destinationFrame >= numFrames) break;

				for (let bf = 0; bf < blockFreq; bf++) {
					const destinationBin = binStart + bf;

					if (destinationBin >= numBins) break;

					const windowValue = win2d[tf * blockFreq + bf]!;
					const destinationPosition = destinationFrame * numBins + destinationBin;
					const sourceValue = synth[blockOffset + tf * blockFreq + bf]!;

					output[destinationPosition] = output[destinationPosition]! + sourceValue * windowValue;
					windowSumSq[destinationPosition] = windowSumSq[destinationPosition]! + windowValue * windowValue;
				}
			}
		}

		profileAdd("ola");
	}

	// Clamp to [0,1] — output is a gain mask.
	for (let flatIndex = 0; flatIndex < maskLength; flatIndex++) {
		const windowWeight = windowSumSq[flatIndex]!;

		if (windowWeight > 1e-8) {
			const normalizedValue = output[flatIndex]! / windowWeight;

			output[flatIndex] = normalizedValue < 0 ? 0 : normalizedValue > 1 ? 1 : normalizedValue;
		} else {
			output[flatIndex] = rawMask[flatIndex]!;
		}
	}

	profileAdd("normalize");
}

// JS fallback (row/column 1D FFT), kept for no-addon environments.
function applyDfttSmoothingJs(
	nlmSmoothed: Float32Array,
	rawMask: Float32Array,
	numFrames: number,
	numBins: number,
	dfttOptions: DfttParams,
	output: Float32Array,
): void {
	const { blockFreq, blockTime, hopFreq, hopTime, threshold } = dfttOptions;

	const winFreq = hanningWindow(blockFreq, false);
	const winTime = hanningWindow(blockTime, false);
	const win2d = new Float32Array(blockTime * blockFreq);

	for (let tf = 0; tf < blockTime; tf++) {
		for (let bf = 0; bf < blockFreq; bf++) {
			win2d[tf * blockFreq + bf] = winTime[tf]! * winFreq[bf]!;
		}
	}

	const windowSumSq = new Float32Array(numFrames * numBins);

	output.fill(0);

	const blockRaw = new Float32Array(blockTime * blockFreq);
	const blockNlm = new Float32Array(blockTime * blockFreq);

	// [t * blockFreq + f]
	const rawRowRe = new Float32Array(blockTime * blockFreq);
	const rawRowIm = new Float32Array(blockTime * blockFreq);
	const nlmRowRe = new Float32Array(blockTime * blockFreq);
	const nlmRowIm = new Float32Array(blockTime * blockFreq);

	// [f * blockTime + t]
	const colInRe = new Float32Array(blockTime * blockFreq);
	const colInIm = new Float32Array(blockTime * blockFreq);

	// [f * blockTime + t]
	const rawColRe = new Float32Array(blockTime * blockFreq);
	const rawColIm = new Float32Array(blockTime * blockFreq);
	const nlmColRe = new Float32Array(blockTime * blockFreq);
	const nlmColIm = new Float32Array(blockTime * blockFreq);

	// [f * blockTime + t]
	const gainColRe = new Float32Array(blockTime * blockFreq);
	const gainColIm = new Float32Array(blockTime * blockFreq);

	const scratchRe = new Float32Array(blockTime);
	const scratchIm = new Float32Array(blockTime);
	const scratchOutRe = new Float32Array(blockTime);
	const scratchOutIm = new Float32Array(blockTime);
	const scratchNegativeReal = new Float32Array(blockTime);

	const rowScratch = new Float32Array(blockFreq);
	const rowScratchRe = new Float32Array(blockFreq);
	const rowScratchIm = new Float32Array(blockFreq);

	// [t * blockFreq + f]
	const synthBlock = new Float32Array(blockTime * blockFreq);

	// FFT workspaces reused across all blocks/rows/columns to avoid per-call allocation in the hot loop.
	const rowFwdWorkspace = createFftWorkspace(blockFreq);
	const colFwdWorkspaceA = createFftWorkspace(blockTime);
	const colFwdWorkspaceB = createFftWorkspace(blockTime);
	const colInvWorkspaceA = createFftWorkspace(blockTime);
	const colInvWorkspaceB = createFftWorkspace(blockTime);
	const rowInvWorkspace = createFftWorkspace(blockFreq);

	for (let frameStart = 0; frameStart < numFrames; frameStart += hopTime) {
		for (let binStart = 0; binStart < numBins; binStart += hopFreq) {
			for (let tf = 0; tf < blockTime; tf++) {
				const srcFrame = frameStart + tf < numFrames ? frameStart + tf : numFrames - 1;

				for (let bf = 0; bf < blockFreq; bf++) {
					const srcBin = binStart + bf < numBins ? binStart + bf : numBins - 1;
					const winVal = win2d[tf * blockFreq + bf]!;
					const srcPos = srcFrame * numBins + srcBin;

					blockRaw[tf * blockFreq + bf] = rawMask[srcPos]! * winVal;
					blockNlm[tf * blockFreq + bf] = nlmSmoothed[srcPos]! * winVal;
				}
			}

			for (let tf = 0; tf < blockTime; tf++) {
				for (let bf = 0; bf < blockFreq; bf++) {
					rowScratch[bf] = blockRaw[tf * blockFreq + bf]!;
				}

				const { re: rowRe, im: rowIm } = fft(rowScratch, rowFwdWorkspace);

				for (let bf = 0; bf < blockFreq; bf++) {
					rawRowRe[tf * blockFreq + bf] = rowRe[bf]!;
					rawRowIm[tf * blockFreq + bf] = rowIm[bf]!;
				}
			}

			for (let tf = 0; tf < blockTime; tf++) {
				for (let bf = 0; bf < blockFreq; bf++) {
					rowScratch[bf] = blockNlm[tf * blockFreq + bf]!;
				}

				const { re: rowRe, im: rowIm } = fft(rowScratch, rowFwdWorkspace);

				for (let bf = 0; bf < blockFreq; bf++) {
					nlmRowRe[tf * blockFreq + bf] = rowRe[bf]!;
					nlmRowIm[tf * blockFreq + bf] = rowIm[bf]!;
				}
			}

			// Transpose to column-major [f * blockTime + t].
			for (let tf = 0; tf < blockTime; tf++) {
				for (let bf = 0; bf < blockFreq; bf++) {
					colInRe[bf * blockTime + tf] = rawRowRe[tf * blockFreq + bf]!;
					colInIm[bf * blockTime + tf] = rawRowIm[tf * blockFreq + bf]!;
				}
			}

			for (let bf = 0; bf < blockFreq; bf++) {
				for (let tf = 0; tf < blockTime; tf++) {
					scratchRe[tf] = colInRe[bf * blockTime + tf]!;
					scratchIm[tf] = colInIm[bf * blockTime + tf]!;
				}

				complexFft(scratchRe, scratchIm, scratchOutRe, scratchOutIm, colFwdWorkspaceA, colFwdWorkspaceB);

				for (let tf = 0; tf < blockTime; tf++) {
					rawColRe[bf * blockTime + tf] = scratchOutRe[tf]!;
					rawColIm[bf * blockTime + tf] = scratchOutIm[tf]!;
				}
			}

			for (let tf = 0; tf < blockTime; tf++) {
				for (let bf = 0; bf < blockFreq; bf++) {
					colInRe[bf * blockTime + tf] = nlmRowRe[tf * blockFreq + bf]!;
					colInIm[bf * blockTime + tf] = nlmRowIm[tf * blockFreq + bf]!;
				}
			}

			for (let bf = 0; bf < blockFreq; bf++) {
				for (let tf = 0; tf < blockTime; tf++) {
					scratchRe[tf] = colInRe[bf * blockTime + tf]!;
					scratchIm[tf] = colInIm[bf * blockTime + tf]!;
				}

				complexFft(scratchRe, scratchIm, scratchOutRe, scratchOutIm, colFwdWorkspaceA, colFwdWorkspaceB);

				for (let tf = 0; tf < blockTime; tf++) {
					nlmColRe[bf * blockTime + tf] = scratchOutRe[tf]!;
					nlmColIm[bf * blockTime + tf] = scratchOutIm[tf]!;
				}
			}

			const sigmaSq = threshold * threshold;

			for (let bf = 0; bf < blockFreq; bf++) {
				for (let tf = 0; tf < blockTime; tf++) {
					const flatIdx = bf * blockTime + tf;
					const nlmRe = nlmColRe[flatIdx]!;
					const nlmIm = nlmColIm[flatIdx]!;
					const nlmMagSq = nlmRe * nlmRe + nlmIm * nlmIm;
					const gain = getWienerGain(nlmMagSq, sigmaSq);

					gainColRe[flatIdx] = rawColRe[flatIdx]! * gain;
					gainColIm[flatIdx] = rawColIm[flatIdx]! * gain;
				}
			}

			for (let bf = 0; bf < blockFreq; bf++) {
				for (let tf = 0; tf < blockTime; tf++) {
					scratchRe[tf] = gainColRe[bf * blockTime + tf]!;
					scratchIm[tf] = gainColIm[bf * blockTime + tf]!;
				}

				complexIfft(
					scratchRe,
					scratchIm,
					scratchOutRe,
					scratchOutIm,
					scratchNegativeReal,
					colInvWorkspaceA,
					colInvWorkspaceB,
				);

				for (let tf = 0; tf < blockTime; tf++) {
					colInRe[bf * blockTime + tf] = scratchOutRe[tf]!;
					colInIm[bf * blockTime + tf] = scratchOutIm[tf]!;
				}
			}

			for (let tf = 0; tf < blockTime; tf++) {
				for (let bf = 0; bf < blockFreq; bf++) {
					rowScratchRe[bf] = colInRe[bf * blockTime + tf]!;
					rowScratchIm[bf] = colInIm[bf * blockTime + tf]!;
				}

				const irowResult = ifft(rowScratchRe, rowScratchIm, rowInvWorkspace);

				for (let bf = 0; bf < blockFreq; bf++) {
					synthBlock[tf * blockFreq + bf] = irowResult[bf]!;
				}
			}

			for (let tf = 0; tf < blockTime; tf++) {
				const destFrame = frameStart + tf;

				if (destFrame >= numFrames) break;

				for (let bf = 0; bf < blockFreq; bf++) {
					const destBin = binStart + bf;

					if (destBin >= numBins) break;

					const winVal = win2d[tf * blockFreq + bf]!;
					const destPos = destFrame * numBins + destBin;

					output[destPos] = output[destPos]! + synthBlock[tf * blockFreq + bf]! * winVal;
					windowSumSq[destPos] = windowSumSq[destPos]! + winVal * winVal;
				}
			}
		}
	}

	// Clamp to [0,1] — output is a gain mask.
	for (let flatIdx = 0; flatIdx < numFrames * numBins; flatIdx++) {
		const ws = windowSumSq[flatIdx]!;

		if (ws > 1e-8) {
			const normalisedVal = output[flatIdx]! / ws;

			output[flatIdx] = normalisedVal < 0 ? 0 : normalisedVal > 1 ? 1 : normalisedVal;
		} else {
			output[flatIdx] = rawMask[flatIdx]!;
		}
	}
}

function assertPositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer, got ${value}`);
	}
}

function assertPowerOfTwo(value: number, name: string): void {
	assertPositiveSafeInteger(value, name);

	if (!Number.isInteger(Math.log2(value))) {
		throw new Error(`${name} must be a power of two, got ${value}`);
	}
}

function typedArraysOverlap(left: Float32Array, right: Float32Array): boolean {
	if (left.buffer !== right.buffer) return false;

	const leftEnd = left.byteOffset + left.byteLength;
	const rightEnd = right.byteOffset + right.byteLength;

	return left.byteOffset < rightEnd && right.byteOffset < leftEnd;
}

function assertArrayLength(values: Float32Array, expectedLength: number, name: string): void {
	if (values.length !== expectedLength) {
		throw new Error(`${name} length must equal ${expectedLength}, got ${values.length}`);
	}
}
