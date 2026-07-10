/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loop with bounds-checked typed array access */

/**
 * Patch size, search range, and paste block size are the exact values reported
 * by iZotope's principal DSP engineer (Lukin & Todd 2007).
 *
 * @see Lukin, A. & Todd, J. (2007). "Suppression of Musical Noise Artifacts
 *   in Audio Noise Reduction by Adaptive 2D Filtering." 123rd AES Convention,
 *   Paper 7168. PDF: http://imaging.cs.msu.ru/pub/MusicalNoise07.pdf
 * @see Buades, A., Coll, B., Morel, J. (2005). "Image Denoising By Non-Local
 *   Averaging." IEEE ICASSP 2005, vol. 2, pp. 25–28.
 */

// Default values match Lukin & Todd 2007, Section 4.3 exactly.
export interface NlmParams {
	/** Patch size for similarity comparison (8). */
	readonly patchSize: number;
	/** Search range along the frequency axis, ±bins (8). */
	readonly searchFreqRadius: number;
	/** Search range into the past along the time axis, in frames (16). */
	readonly searchTimePre: number;
	/** Search range into the future along the time axis, in frames (4). */
	readonly searchTimePost: number;
	/** Paste block size — one weight is computed per pasteBlockSize×pasteBlockSize region (4). */
	readonly pasteBlockSize: number;
	/** Smoothing threshold h in W = exp(-||v - v'||² / h²). Scaled from user artifactSmoothing. */
	readonly threshold: number;
}

/**
 * @param mask      - Input gain mask, numFrames × numBins, flat row-major (frame-major).
 * @param numFrames - Number of STFT frames.
 * @param numBins   - Number of frequency bins per frame.
 * @param nlmOptions - NLM algorithm parameters (see NlmParams).
 * @param output     - Pre-allocated output array, same shape as mask.
 *
 * @see Lukin, A. & Todd, J. (2007). "Suppression of Musical Noise Artifacts
 *   in Audio Noise Reduction by Adaptive 2D Filtering." 123rd AES Convention,
 *   Paper 7168. PDF: http://imaging.cs.msu.ru/pub/MusicalNoise07.pdf
 * @see Buades, A., Coll, B., Morel, J. (2005). "Image Denoising By Non-Local
 *   Averaging." IEEE ICASSP 2005, vol. 2, pp. 25–28.
 */
export function applyNlmSmoothing(
	mask: Float32Array,
	numFrames: number,
	numBins: number,
	nlmOptions: NlmParams,
	output: Float32Array,
): void {
	applyNlmSmoothingRange(mask, numFrames, numBins, nlmOptions, output, 0, numFrames);
}

/**
 * Range-parameterized form of {@link applyNlmSmoothing}: processes only the paste
 * blocks whose `blockFrame` falls in `[blockFrameStart, blockFrameEnd)`. Both bounds
 * are multiples of `pasteBlockSize` (except `blockFrameEnd` may equal `numFrames`).
 * Reads the whole immutable `mask` and writes only the output rows it owns, so
 * disjoint ranges can run concurrently over shared buffers. The per-block body is
 * identical to the full-pass loop.
 */
export function applyNlmSmoothingRange(
	mask: Float32Array,
	numFrames: number,
	numBins: number,
	nlmOptions: NlmParams,
	output: Float32Array,
	blockFrameStart: number,
	blockFrameEnd: number,
): void {
	const { patchSize, searchFreqRadius, searchTimePre, searchTimePost, pasteBlockSize, threshold } = nlmOptions;
	const hSq = threshold * threshold;
	const halfPatch = Math.floor(patchSize / 2);

	for (let blockFrame = blockFrameStart; blockFrame < blockFrameEnd; blockFrame += pasteBlockSize) {
		for (let blockBin = 0; blockBin < numBins; blockBin += pasteBlockSize) {
			const centreFrame = blockFrame + Math.floor(pasteBlockSize / 2);
			const centreBin = blockBin + Math.floor(pasteBlockSize / 2);

			let weightSum = 0;
			let valueSum = 0;

			const timeStart = centreFrame - searchTimePre;
			const timeEnd = centreFrame + searchTimePost;
			const freqStart = centreBin - searchFreqRadius;
			const freqEnd = centreBin + searchFreqRadius;

			for (let candFrame = timeStart; candFrame <= timeEnd; candFrame++) {
				const clampedCandFrame = candFrame < 0 ? 0 : candFrame >= numFrames ? numFrames - 1 : candFrame;

				for (let candBin = freqStart; candBin <= freqEnd; candBin++) {
					const clampedCandBin = candBin < 0 ? 0 : candBin >= numBins ? numBins - 1 : candBin;

					let patchDistSq = 0;

					for (let pf = -halfPatch; pf < halfPatch; pf++) {
						for (let pb = -halfPatch; pb < halfPatch; pb++) {
							const cf = centreFrame + pf;
							const cBin = centreBin + pb;
							const cf2 = cf < 0 ? 0 : cf >= numFrames ? numFrames - 1 : cf;
							const cBin2 = cBin < 0 ? 0 : cBin >= numBins ? numBins - 1 : cBin;
							const vCentre = mask[cf2 * numBins + cBin2]!;

							const df = clampedCandFrame + pf;
							const db = clampedCandBin + pb;
							const df2 = df < 0 ? 0 : df >= numFrames ? numFrames - 1 : df;
							const db2 = db < 0 ? 0 : db >= numBins ? numBins - 1 : db;
							const vCand = mask[df2 * numBins + db2]!;

							const diff = vCentre - vCand;

							patchDistSq += diff * diff;
						}
					}

					const weight = hSq > 0 ? Math.exp(-patchDistSq / hSq) : patchDistSq === 0 ? 1 : 0;

					weightSum += weight;

					valueSum += weight * mask[clampedCandFrame * numBins + clampedCandBin]!;
				}
			}

			const smoothed = weightSum > 0 ? valueSum / weightSum : mask[centreFrame * numBins + centreBin]!;

			for (let pf = 0; pf < pasteBlockSize; pf++) {
				const outFrame = blockFrame + pf;

				if (outFrame >= numFrames) break;

				for (let pb = 0; pb < pasteBlockSize; pb++) {
					const outBin = blockBin + pb;

					if (outBin >= numBins) break;

					output[outFrame * numBins + outBin] = smoothed;
				}
			}
		}
	}
}
