/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loop with bounds-checked typed array access */

// Gain-mask adaptation of Buades, Coll, and Morel, "A Non-Local Algorithm for Image Denoising" (2005), and Lukin and Todd, "Suppression of Musical Noise Artifacts in Audio Noise Reduction by Adaptive 2D Filtering" (2007).

export interface NlmParams {
	/** Patch size for similarity comparison (8). */
	readonly patchSize: number;
	/** Search range along the frequency axis, ±bins (8). */
	readonly searchFreqRadius: number;
	/** Search range into the past along the time axis, in frames (16). */
	readonly searchTimePre: number;
	/** Search range into the future along the time axis, in frames (4). */
	readonly searchTimePost: number;
	/** Paste block size; the paper uses 4x4 and de-bleed uses a measured 8x8 adaptation. */
	readonly pasteBlockSize: number;
	/** Smoothing threshold h in W = exp(-||v - v'||² / h²). Scaled from user artifactSmoothing. */
	readonly threshold: number;
}

export function applyNlmSmoothing(
	mask: Float32Array,
	numFrames: number,
	numBins: number,
	nlmOptions: NlmParams,
	output: Float32Array,
): void {
	applyNlmSmoothingRange(mask, numFrames, numBins, nlmOptions, output, 0, numFrames);
}

// Writes only its aligned block-frame range, so disjoint ranges can share the input and output buffers.
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
	const maskLength = numFrames * numBins;

	assertNonnegativeSafeInteger(numFrames, "NLM numFrames");
	assertNonnegativeSafeInteger(numBins, "NLM numBins");

	if (!Number.isSafeInteger(maskLength)) {
		throw new Error("NLM mask dimensions exceed the safe integer range");
	}

	if (mask.length !== maskLength || output.length !== maskLength) {
		throw new Error(`NLM mask and output lengths must equal ${maskLength}`);
	}

	if (!Number.isSafeInteger(patchSize) || patchSize <= 0 || patchSize % 2 !== 0) {
		throw new Error(`NLM patchSize must be a positive even integer, got ${patchSize}`);
	}

	assertNonnegativeSafeInteger(searchFreqRadius, "NLM searchFreqRadius");
	assertNonnegativeSafeInteger(searchTimePre, "NLM searchTimePre");
	assertNonnegativeSafeInteger(searchTimePost, "NLM searchTimePost");

	if (!Number.isSafeInteger(pasteBlockSize) || pasteBlockSize <= 0) {
		throw new Error(`NLM pasteBlockSize must be a positive integer, got ${pasteBlockSize}`);
	}

	if (!Number.isFinite(threshold) || threshold < 0) {
		throw new Error(`NLM threshold must be finite and nonnegative, got ${threshold}`);
	}

	assertNonnegativeSafeInteger(blockFrameStart, "NLM blockFrameStart");
	assertNonnegativeSafeInteger(blockFrameEnd, "NLM blockFrameEnd");

	if (
		blockFrameStart > blockFrameEnd ||
		blockFrameEnd > numFrames ||
		blockFrameStart % pasteBlockSize !== 0 ||
		(blockFrameEnd !== numFrames && blockFrameEnd % pasteBlockSize !== 0)
	) {
		throw new Error("NLM frame range must be ordered, in bounds, and aligned to pasteBlockSize");
	}

	if (threshold === 0) {
		if (blockFrameStart === 0 && blockFrameEnd === numFrames) {
			output.set(mask);
		} else {
			const outputStart = blockFrameStart * numBins;
			const outputEnd = blockFrameEnd * numBins;

			output.set(mask.subarray(outputStart, outputEnd), outputStart);
		}

		return;
	}

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

			const clampedCentreFrame = Math.min(centreFrame, numFrames - 1);
			const clampedCentreBin = Math.min(centreBin, numBins - 1);
			const smoothed = weightSum > 0 ? valueSum / weightSum : mask[clampedCentreFrame * numBins + clampedCentreBin]!;
			const clampedSmoothed = smoothed < 0 ? 0 : smoothed > 1 ? 1 : smoothed;

			for (let pf = 0; pf < pasteBlockSize; pf++) {
				const outFrame = blockFrame + pf;

				if (outFrame >= numFrames) break;

				for (let pb = 0; pb < pasteBlockSize; pb++) {
					const outBin = blockBin + pb;

					if (outBin >= numBins) break;

					output[outFrame * numBins + outBin] = clampedSmoothed;
				}
			}
		}
	}
}

function assertNonnegativeSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a nonnegative integer, got ${value}`);
	}
}
