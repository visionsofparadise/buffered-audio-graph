import { type Anchors, gainDbAt } from "./curve";
import type { DetectionHistogram } from "./measurement";

export const BOOST_LOWER_BOUND = -30;
export const BOOST_UPPER_BOUND = 30;

const LINEAR_AMPLITUDE_EPSILON = 1e-12;

export function predictOutputLufs(sourceLufs: number, anchors: Anchors, histogram: DetectionHistogram): number {
	const { buckets, bucketMax, totalSamples } = histogram;
	const bucketCount = buckets.length;

	if (bucketCount === 0 || bucketMax <= 0 || totalSamples === 0) return -Infinity;

	if (!Number.isFinite(sourceLufs)) return -Infinity;

	const bucketWidth = bucketMax / bucketCount;
	let weightedGainEnergy = 0;
	let weightedSourceEnergy = 0;

	for (let bucketIdx = 0; bucketIdx < bucketCount; bucketIdx++) {
		const count = buckets[bucketIdx] ?? 0;

		if (count === 0) continue;

		const centreLinear = (bucketIdx + 0.5) * bucketWidth;

		if (centreLinear < LINEAR_AMPLITUDE_EPSILON) continue;

		const energy = count * centreLinear * centreLinear;
		const centreDb = 20 * Math.log10(centreLinear);
		const gainDb = gainDbAt(centreDb, anchors);
		const gainLinear = Math.pow(10, gainDb / 20);

		weightedSourceEnergy += energy;
		weightedGainEnergy += energy * gainLinear * gainLinear;
	}

	if (weightedSourceEnergy <= 0 || weightedGainEnergy <= 0) return -Infinity;

	const lufsShift = 10 * Math.log10(weightedGainEnergy / weightedSourceEnergy);

	return sourceLufs + lufsShift;
}

const MAX_BISECT_ITERATIONS = 50;

export function assignPeakGainDb(boost: number, tpCap: number, neverExpand: boolean): number {
	return neverExpand ? Math.min(boost, tpCap) : tpCap;
}

export function bisectBForTargetLufs(args: {
	sourceLufs: number;
	targetLufs: number;
	anchors: Pick<Anchors, "floorDb" | "pivotDb" | "limitDb">;
	histogram: DetectionHistogram;
	tpCap: number;
	neverExpand: boolean;
	residual: number;
	tolerance: number;
}): number {
	const { sourceLufs, targetLufs, anchors: anchorBase, histogram, tpCap, neverExpand, residual, tolerance } = args;

	if (!Number.isFinite(sourceLufs)) return 0;

	const predictAt = (candidateB: number): number => {
		const candidateAnchors: Anchors = {
			floorDb: anchorBase.floorDb,
			pivotDb: anchorBase.pivotDb,
			limitDb: anchorBase.limitDb,
			B: candidateB,
			peakGainDb: assignPeakGainDb(candidateB, tpCap, neverExpand),
		};

		return predictOutputLufs(sourceLufs, candidateAnchors, histogram) + residual;
	};

	let lower = BOOST_LOWER_BOUND;
	let upper = BOOST_UPPER_BOUND;
	const lowerLufs = predictAt(lower);
	const upperLufs = predictAt(upper);
	const lowerErr = lowerLufs - targetLufs;
	const upperErr = upperLufs - targetLufs;

	if (!Number.isFinite(lowerErr) || !Number.isFinite(upperErr) || Math.sign(lowerErr) === Math.sign(upperErr)) {
		const lowerAbs = Number.isFinite(lowerErr) ? Math.abs(lowerErr) : Infinity;
		const upperAbs = Number.isFinite(upperErr) ? Math.abs(upperErr) : Infinity;

		return lowerAbs <= upperAbs ? lower : upper;
	}

	let bestB = lower;
	let bestAbsErr = Math.abs(lowerErr);
	let workingLowerErr = lowerErr;
	const subToleranceBracket = tolerance / 100;

	for (let iteration = 0; iteration < MAX_BISECT_ITERATIONS; iteration++) {
		const mid = 0.5 * (lower + upper);
		const midErr = predictAt(mid) - targetLufs;

		if (Math.abs(midErr) < bestAbsErr || iteration === 0) {
			bestB = mid;
			bestAbsErr = Math.abs(midErr);
		}

		if (Math.abs(midErr) < tolerance) {
			bestB = mid;

			break;
		}

		if (!Number.isFinite(midErr) || Math.sign(midErr) === Math.sign(workingLowerErr)) {
			lower = mid;
			workingLowerErr = midErr;
		} else {
			upper = mid;
		}

		if (upper - lower < subToleranceBracket) break;
	}

	return bestB;
}
