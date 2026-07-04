/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loop with bounds-checked typed array access */

/**
 * @see Welch 1967; Cohen 2003; Gerkmann & Hendriks 2012; Boll 1979.
 */

export interface TransferFunction {
	readonly real: Float32Array;
	readonly imag: Float32Array;
}

export interface TransferAccumulator {
	readonly crossReal: Float32Array;
	readonly crossImag: Float32Array;
	readonly weightedAutoPower: Float32Array;
}

/** Reuse one accumulator across the whole stream (re-creating per chunk resets the running sums). */
export function createTransferAccumulator(numBins: number): TransferAccumulator {
	return {
		crossReal: new Float32Array(numBins),
		crossImag: new Float32Array(numBins),
		weightedAutoPower: new Float32Array(numBins),
	};
}

/** `maxRefPow` must be the WHOLE-FILE max of `|R|²`, not per-chunk, or streaming weights drift from the one-shot estimator. */
export function findMaxRefPower(
	refReal: Float32Array,
	refImag: Float32Array,
	numFrames: number,
	numBins: number,
): number {
	let maxRefPow = 0;
	const total = numFrames * numBins;

	for (let index = 0; index < total; index++) {
		const rrb = refReal[index]!;
		const rib = refImag[index]!;
		const refPow = rrb * rrb + rib * rib;

		if (refPow > maxRefPow) maxRefPow = refPow;
	}

	return maxRefPow;
}

/**
 * For bit-compatibility with the one-shot path, `weightEpsilon` must be `1e-10 · (maxRefPow + 1e-20)` with `maxRefPow` the WHOLE-FILE max of `|R|²` (see {@link findMaxRefPower}); a per-chunk max drifts the estimate.
 * @see header JSDoc.
 */
export function accumulateTransferChunk(
	targetReal: Float32Array,
	targetImag: Float32Array,
	refReal: Float32Array,
	refImag: Float32Array,
	numFrames: number,
	numBins: number,
	weightEpsilon: number,
	accumulator: TransferAccumulator,
): void {
	const { crossReal, crossImag, weightedAutoPower } = accumulator;

	for (let frame = 0; frame < numFrames; frame++) {
		const frameOffset = frame * numBins;

		for (let bin = 0; bin < numBins; bin++) {
			const trb = targetReal[frameOffset + bin]!;
			const tib = targetImag[frameOffset + bin]!;
			const rrb = refReal[frameOffset + bin]!;
			const rib = refImag[frameOffset + bin]!;

			const targetPow = trb * trb + tib * tib;
			const refPow = rrb * rrb + rib * rib;

			const weight = refPow / (targetPow + refPow + weightEpsilon);

			crossReal[bin] = crossReal[bin]! + weight * (trb * rrb + tib * rib);
			crossImag[bin] = crossImag[bin]! + weight * (tib * rrb - trb * rib);

			weightedAutoPower[bin] = weightedAutoPower[bin]! + weight * refPow;
		}
	}
}

/** Final-division regulariser is `epsilon ?? 1e-10 · max(weightedAutoPower)`, computed across bins here because it cannot be known before the last chunk. */
export function finalizeTransferFunction(
	accumulator: TransferAccumulator,
	epsilon?: number,
): TransferFunction {
	const { crossReal, crossImag, weightedAutoPower } = accumulator;
	const numBins = weightedAutoPower.length;

	let maxAutoPower = 0;

	for (let bin = 0; bin < numBins; bin++) {
		if (weightedAutoPower[bin]! > maxAutoPower) maxAutoPower = weightedAutoPower[bin]!;
	}

	const eps = epsilon ?? 1e-10 * maxAutoPower;

	const hReal = new Float32Array(numBins);
	const hImag = new Float32Array(numBins);

	for (let bin = 0; bin < numBins; bin++) {
		const denom = weightedAutoPower[bin]! + eps;

		hReal[bin] = crossReal[bin]! / denom;
		hImag[bin] = crossImag[bin]! / denom;
	}

	return { real: hReal, imag: hImag };
}
