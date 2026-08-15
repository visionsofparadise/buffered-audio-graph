import { describe, expect, it } from "vitest";
import { dbToLinear, linearToDb } from "@buffered-audio/utils";
import { type Anchors, gainDbAt } from "./curve";
import type { DetectionHistogram } from "./measurement";
import { assignPeakGainDb, BOOST_LOWER_BOUND, BOOST_UPPER_BOUND, bisectBForTargetLufs, predictOutputLufs } from "./solve";

const baseAnchors = (overrides: Partial<Anchors> = {}): Anchors => ({
	floorDb: null,
	pivotDb: -30,
	limitDb: -3,
	B: 0,
	peakGainDb: 0,
	...overrides,
});

/**
 * Build a synthetic detection-amplitude histogram with all samples
 * sitting at a single linear-amplitude level.
 */
function singleLevelHistogram(
	targetLevelDb: number,
	totalSamples: number,
	bucketCount = 1024,
	bucketMaxDb = 0,
): DetectionHistogram {
	const bucketMax = dbToLinear(bucketMaxDb);
	const buckets = new Uint32Array(bucketCount);
	const targetLinear = dbToLinear(targetLevelDb);
	const bucketWidth = bucketMax / bucketCount;
	const bucketIdx = Math.min(bucketCount - 1, Math.max(0, Math.floor(targetLinear / bucketWidth)));

	buckets[bucketIdx] = totalSamples;

	return { buckets, bucketMax, totalSamples };
}

/**
 * Build a uniform multi-bucket histogram from `lowLevelDb` to
 * `highLevelDb` (linear-uniform within the dB-defined range).
 */
function uniformDbRangeHistogram(
	lowLevelDb: number,
	highLevelDb: number,
	totalSamples: number,
	bucketCount = 1024,
	bucketMaxDb = 0,
): DetectionHistogram {
	const bucketMax = dbToLinear(bucketMaxDb);
	const buckets = new Uint32Array(bucketCount);
	const bucketWidth = bucketMax / bucketCount;
	const lowLinear = dbToLinear(lowLevelDb);
	const highLinear = dbToLinear(highLevelDb);
	const lowBucket = Math.min(bucketCount - 1, Math.max(0, Math.floor(lowLinear / bucketWidth)));
	const highBucket = Math.min(bucketCount - 1, Math.max(0, Math.floor(highLinear / bucketWidth)));
	const span = Math.max(1, highBucket - lowBucket + 1);
	const perBucket = Math.floor(totalSamples / span);
	let placed = 0;

	for (let bucketIdx = lowBucket; bucketIdx <= highBucket; bucketIdx++) {
		buckets[bucketIdx] = perBucket;
		placed += perBucket;
	}

	buckets[lowBucket]! += totalSamples - placed;

	return { buckets, bucketMax, totalSamples };
}

/**
 * Closed-form reference for the histogram-based predictor:
 *
 *   weighted_g² = Σ_b count[b] · centreLinear[b]² · g²(centreDb_b)
 *   total_x²    = Σ_b count[b] · centreLinear[b]²
 *   ΔLUFS       = 10 · log10( weighted_g² / total_x² )
 */
function referenceLufsShift(anchors: Anchors, histogram: DetectionHistogram): number {
	const { buckets, bucketMax } = histogram;
	const bucketCount = buckets.length;
	const bucketWidth = bucketMax / bucketCount;
	let weightedGainEnergy = 0;
	let weightedSourceEnergy = 0;

	for (let bucketIdx = 0; bucketIdx < bucketCount; bucketIdx++) {
		const count = buckets[bucketIdx] ?? 0;

		if (count === 0) continue;

		const centreLinear = (bucketIdx + 0.5) * bucketWidth;

		if (centreLinear <= 0) continue;

		const energy = count * centreLinear * centreLinear;
		const centreDb = linearToDb(centreLinear);
		const gainDb = gainDbAt(centreDb, anchors);
		const gainLinear = Math.pow(10, gainDb / 20);

		weightedSourceEnergy += energy;
		weightedGainEnergy += energy * gainLinear * gainLinear;
	}

	return 10 * Math.log10(weightedGainEnergy / weightedSourceEnergy);
}

describe("predictOutputLufs", () => {
	it("returns -Infinity for an empty histogram", () => {
		const anchors = baseAnchors();
		const histogram: DetectionHistogram = {
			buckets: new Uint32Array(0),
			bucketMax: 0,
			totalSamples: 0,
		};
		expect(predictOutputLufs(-20, anchors, histogram)).toBe(-Infinity);
	});

	it("returns -Infinity for a silent histogram (bucketMax = 0)", () => {
		const anchors = baseAnchors();
		const histogram: DetectionHistogram = {
			buckets: new Uint32Array(1024),
			bucketMax: 0,
			totalSamples: 0,
		};
		expect(predictOutputLufs(-20, anchors, histogram)).toBe(-Infinity);
	});

	it("matches closed-form sourceLufs + 10·log10(mean(g²)) on a known histogram and curve", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const anchors = baseAnchors({ pivotDb: -28, limitDb: -6, B: 3, peakGainDb: 5 });
		const sourceLufs = -23;
		const predicted = predictOutputLufs(sourceLufs, anchors, histogram);
		const expectedShift = referenceLufsShift(anchors, histogram);

		expect(predicted).toBeCloseTo(sourceLufs + expectedShift, 6);
	});

	it("single-level histogram + flat curve (B=peakGainDb): predicted shift equals body gain", () => {
		const histogram = singleLevelHistogram(-20, 50_000);
		const anchors = baseAnchors({ pivotDb: -30, limitDb: -3, B: 6, peakGainDb: 6 });
		const sourceLufs = -23;
		const predicted = predictOutputLufs(sourceLufs, anchors, histogram);

		expect(predicted).toBeCloseTo(sourceLufs + 6, 4);
	});

	it("is monotone increasing in B for a non-empty histogram", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const sourceLufs = -22;
		const lufsAt = (candidateB: number): number => {
			const anchors = baseAnchors({ B: candidateB, peakGainDb: candidateB });

			return predictOutputLufs(sourceLufs, anchors, histogram);
		};
		const bs = [-10, -5, 0, 5, 10];
		const predicted = bs.map(lufsAt);

		for (let i = 0; i < predicted.length - 1; i++) {
			expect(predicted[i + 1]).toBeGreaterThan(predicted[i]!);
		}
	});

	it("predictor's per-bucket gain equals gainDbAt evaluated at the bucket centre dBFS", () => {
		// Sanity that the predictor and the curve are talking about
		// the same gain function on the same axis (detection amplitude
		// in dBFS). Protects against a refactor where the predictor
		// uses an outdated/inlined gain formula or a different level
		// axis (the original bug: block-LUFS axis vs per-sample-
		// detection axis — 9.3 LUFS error on Pierce).
		const histogram = uniformDbRangeHistogram(-30, -5, 60_000);
		const anchors = baseAnchors({ pivotDb: -28, limitDb: -6, B: 4, peakGainDb: 7 });
		const reference = referenceLufsShift(anchors, histogram);
		const sourceLufs = -22;
		const predicted = predictOutputLufs(sourceLufs, anchors, histogram);

		expect(predicted - sourceLufs).toBeCloseTo(reference, 6);
	});
});

describe("bisectBForTargetLufs", () => {
	it("returns a B for which predictOutputLufs(B, assigned peakGainDb) + residual ≈ targetLufs", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const sourceLufs = -23;
		const targetLufs = -19;
		const anchorsBase = { floorDb: null, pivotDb: -28, limitDb: -6 };
		const tpCap = -1 - -6;
		const neverExpand = false;
		const tolerance = 0.1;
		const landingB = bisectBForTargetLufs({
			sourceLufs,
			targetLufs,
			anchors: anchorsBase,
			histogram,
			tpCap,
			neverExpand,
			residual: 0,
			tolerance,
		});

		expect(landingB).toBeGreaterThanOrEqual(BOOST_LOWER_BOUND);
		expect(landingB).toBeLessThanOrEqual(BOOST_UPPER_BOUND);

		const landedAnchors: Anchors = {
			...anchorsBase,
			B: landingB,
			peakGainDb: assignPeakGainDb(landingB, tpCap, neverExpand),
		};
		const predictedAtLanding = predictOutputLufs(sourceLufs, landedAnchors, histogram);

		expect(Math.abs(predictedAtLanding - targetLufs)).toBeLessThan(tolerance);
	});

	it("respects the [BOOST_LOWER_BOUND, BOOST_UPPER_BOUND] bracket", () => {
		const histogram = uniformDbRangeHistogram(-28, -2, 80_000);
		const landingB = bisectBForTargetLufs({
			sourceLufs: -22,
			targetLufs: 100,
			anchors: { floorDb: null, pivotDb: -30, limitDb: -9 },
			histogram,
			tpCap: 8,
			neverExpand: false,
			residual: 0,
			tolerance: 0.1,
		});

		expect(landingB).toBeGreaterThanOrEqual(BOOST_LOWER_BOUND);
		expect(landingB).toBeLessThanOrEqual(BOOST_UPPER_BOUND);
	});

	it("neverExpand true with expansive tpCap assigns peakGainDb = B", () => {
		const histogram = uniformDbRangeHistogram(-32, -14, 80_000);
		const sourceLufs = -25;
		const targetLufs = -22;
		const anchorsBase = { floorDb: null, pivotDb: -35, limitDb: -10 };
		const tpCap = 20;
		const neverExpand = true;
		const tolerance = 0.1;
		const landingB = bisectBForTargetLufs({
			sourceLufs,
			targetLufs,
			anchors: anchorsBase,
			histogram,
			tpCap,
			neverExpand,
			residual: 0,
			tolerance,
		});

		expect(assignPeakGainDb(landingB, tpCap, neverExpand)).toBe(landingB);

		const landedAnchors: Anchors = {
			...anchorsBase,
			B: landingB,
			peakGainDb: landingB,
		};
		const predictedAtLanding = predictOutputLufs(sourceLufs, landedAnchors, histogram);

		expect(Math.abs(predictedAtLanding - targetLufs)).toBeLessThan(tolerance);
	});

	it("returns 0 for non-finite sourceLufs", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const landingB = bisectBForTargetLufs({
			sourceLufs: -Infinity,
			targetLufs: -20,
			anchors: { floorDb: null, pivotDb: -28, limitDb: -6 },
			histogram,
			tpCap: 5,
			neverExpand: false,
			residual: 0,
			tolerance: 0.1,
		});

		expect(landingB).toBe(0);
	});

	it("neverExpand true makes the predictor peakGainDb follow min(B, tpCap) for a negative B", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const sourceLufs = -20;
		const targetLufs = -26;
		const anchorsBase = { floorDb: null, pivotDb: -28, limitDb: -6 };
		const tpCap = 12;
		const neverExpand = true;
		const tolerance = 0.1;
		const landingB = bisectBForTargetLufs({
			sourceLufs,
			targetLufs,
			anchors: anchorsBase,
			histogram,
			tpCap,
			neverExpand,
			residual: 0,
			tolerance,
		});

		expect(landingB).toBeLessThan(0);
		expect(assignPeakGainDb(landingB, tpCap, neverExpand)).toBe(landingB);

		const assignedAnchors: Anchors = {
			...anchorsBase,
			B: landingB,
			peakGainDb: assignPeakGainDb(landingB, tpCap, neverExpand),
		};
		const ceilingAnchors: Anchors = {
			...anchorsBase,
			B: landingB,
			peakGainDb: tpCap,
		};

		expect(Math.abs(predictOutputLufs(sourceLufs, assignedAnchors, histogram) - targetLufs)).toBeLessThan(tolerance);
		expect(predictOutputLufs(sourceLufs, ceilingAnchors, histogram)).not.toBeCloseTo(targetLufs, 1);
	});

	it("a non-zero residual shifts the bisect landing by about that residual", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const sourceLufs = -23;
		const targetLufs = -19;
		const anchorsBase = { floorDb: null, pivotDb: -28, limitDb: -6 };
		const tpCap = 20;
		const neverExpand = true;
		const tolerance = 0.1;
		const residual = 1.5;
		const shared = {
			sourceLufs,
			targetLufs,
			anchors: anchorsBase,
			histogram,
			tpCap,
			neverExpand,
			tolerance,
		};
		const landingWithoutResidual = bisectBForTargetLufs({ ...shared, residual: 0 });
		const landingWithResidual = bisectBForTargetLufs({ ...shared, residual });

		expect(landingWithoutResidual - landingWithResidual).toBeCloseTo(residual, 0);

		const landedAnchors: Anchors = {
			...anchorsBase,
			B: landingWithResidual,
			peakGainDb: assignPeakGainDb(landingWithResidual, tpCap, neverExpand),
		};

		expect(
			Math.abs(predictOutputLufs(sourceLufs, landedAnchors, histogram) + residual - targetLufs),
		).toBeLessThan(tolerance);
	});
});
