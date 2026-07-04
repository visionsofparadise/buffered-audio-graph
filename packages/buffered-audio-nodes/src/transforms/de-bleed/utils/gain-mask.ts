/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loop with bounds-checked typed array access */

/** @see Boll 1979. */

/**
 * @param targetReal    - Real part of target STFT frame, length numBins.
 * @param targetImag    - Imaginary part of target STFT frame, length numBins.
 * @param refReals      - Per-reference real STFT frame rows; length refCount, each length numBins.
 * @param refImags      - Per-reference imaginary STFT frame rows; length refCount, each length numBins.
 * @param transferReals - Per-reference H real parts; length refCount, each length numBins.
 * @param transferImags - Per-reference H imaginary parts; length refCount, each length numBins.
 * @param alpha         - Oversubtraction factor.
 * @param epsilon       - Small regularizer to prevent division by zero (e.g. 1e-10).
 * @param outMask       - Output Float32Array of length numBins, reused across frames.
 * @see Boll 1979.
 */
export function computeFrameGainMask(
	targetReal: Float32Array,
	targetImag: Float32Array,
	refReals: ReadonlyArray<Float32Array>,
	refImags: ReadonlyArray<Float32Array>,
	transferReals: ReadonlyArray<Float32Array>,
	transferImags: ReadonlyArray<Float32Array>,
	alpha: number,
	epsilon: number,
	outMask: Float32Array,
): void {
	const numBins = outMask.length;
	const refCount = refReals.length;

	for (let bin = 0; bin < numBins; bin++) {
		const trb = targetReal[bin]!;
		const tib = targetImag[bin]!;

		let bRTotal = 0;
		let bITotal = 0;

		for (let refIndex = 0; refIndex < refCount; refIndex++) {
			const rrb = refReals[refIndex]![bin]!;
			const rib = refImags[refIndex]![bin]!;
			const hrb = transferReals[refIndex]![bin]!;
			const hib = transferImags[refIndex]![bin]!;

			bRTotal += hrb * rrb - hib * rib;
			bITotal += hrb * rib + hib * rrb;
		}

		const bMag = Math.sqrt(bRTotal * bRTotal + bITotal * bITotal);
		const tMag = Math.sqrt(trb * trb + tib * tib);

		const raw = Math.max(tMag - alpha * bMag, 0) / (tMag + epsilon);

		// Clamp to [0,1] defensively; values > 1 should not occur.
		outMask[bin] = raw < 1 ? raw : 1;
	}
}
