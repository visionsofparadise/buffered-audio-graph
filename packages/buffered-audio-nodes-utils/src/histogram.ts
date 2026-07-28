import { histogramMedian } from "./histogram-median";

export interface AmplitudeHistogram {
	buckets: Uint32Array;
	bucketMax: number;
	median: number;
}

export function amplitudeHistogram(channels: ReadonlyArray<Float32Array>, bucketCount: number): AmplitudeHistogram {
	if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
		throw new Error(`amplitudeHistogram: bucketCount must be a positive integer, got ${String(bucketCount)}`);
	}

	const buckets = new Uint32Array(bucketCount);
	let totalSamples = 0;
	let bucketMax = 0;

	for (const channel of channels) {
		const length = channel.length;

		totalSamples += length;

		for (let index = 0; index < length; index++) {
			const value = Math.abs(channel[index] ?? 0);

			if (value > bucketMax) bucketMax = value;
		}
	}

	if (totalSamples === 0 || bucketMax === 0) {
		return { buckets, bucketMax: 0, median: 0 };
	}

	const scale = bucketCount / bucketMax;
	const lastBucket = bucketCount - 1;

	for (const channel of channels) {
		const length = channel.length;

		for (let index = 0; index < length; index++) {
			const value = Math.abs(channel[index] ?? 0);
			let bucketIndex = Math.floor(value * scale);

			if (bucketIndex < 0) bucketIndex = 0;
			else if (bucketIndex > lastBucket) bucketIndex = lastBucket;

			buckets[bucketIndex] = (buckets[bucketIndex] ?? 0) + 1;
		}
	}

	return { buckets, bucketMax, median: histogramMedian(buckets, bucketCount, totalSamples, bucketMax) };
}
