export function computeTotalSamples(buckets: Uint32Array): number {
	let totalSamples = 0;

	for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) totalSamples += buckets[bucketIndex] ?? 0;

	return totalSamples;
}

/**
 * Linear-interpolated percentile over an amplitude histogram: walks the cumulative bucket counts to the
 * `percent` target and interpolates within the crossing bucket. Returns 0 for an empty distribution and
 * `bucketMax` when the target sits past the final bucket.
 */
export function amplitudePercentile(buckets: Uint32Array, bucketMax: number, totalSamples: number, percent: number): number {
	if (totalSamples === 0 || bucketMax === 0) return 0;

	const target = (percent / 100) * totalSamples;
	let cumulative = 0;

	for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
		const count = buckets[bucketIndex] ?? 0;
		const next = cumulative + count;

		if (next >= target) {
			const fractionIntoBucket = count > 0 ? (target - cumulative) / count : 0;
			const bucketWidth = bucketMax / buckets.length;

			return (bucketIndex + fractionIntoBucket) * bucketWidth;
		}

		cumulative = next;
	}

	return bucketMax;
}
