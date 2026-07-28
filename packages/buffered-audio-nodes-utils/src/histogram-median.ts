export function histogramMedian(
	buckets: Uint32Array,
	bucketCount: number,
	totalSamples: number,
	bucketMax: number,
): number {
	const target = totalSamples / 2;
	const bucketWidth = bucketMax / bucketCount;
	let cumulative = 0;
	let median = 0;

	for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
		const count = buckets[bucketIndex] ?? 0;
		const next = cumulative + count;

		if (next >= target) {
			const fraction = count > 0 ? (target - cumulative) / count : 0;

			median = (bucketIndex + fraction) * bucketWidth;

			break;
		}

		cumulative = next;
	}

	return median;
}
