export class AmplitudeHistogramAccumulator {
	private readonly bucketCount: number;
	private buckets: Uint32Array;
	private bucketMax = 0;
	private totalSamples = 0;
	private pendingZeros = 0;
	private finalized = false;
	private cachedResult: { buckets: Uint32Array; bucketMax: number; median: number } | undefined;

	constructor(bucketCount: number) {
		if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
			throw new Error(`AmplitudeHistogramAccumulator: bucketCount must be a positive integer, got ${String(bucketCount)}`);
		}

		this.bucketCount = bucketCount;
		this.buckets = new Uint32Array(bucketCount);
	}

	// Consumes `frames` samples per channel; throws if any channel has fewer than `frames` samples or if `finalize` was already called.
	push(channels: ReadonlyArray<Float32Array>, frames: number): void {
		if (this.finalized) {
			throw new Error("AmplitudeHistogramAccumulator: push() called after finalize()");
		}

		if (frames <= 0) return;

		for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
			const channel = channels[channelIndex];

			if (channel === undefined || channel.length < frames) {
				throw new Error(`AmplitudeHistogramAccumulator: channel ${channelIndex} has ${channel?.length ?? 0} samples, fewer than the requested ${frames}`);
			}
		}

		let chunkMax = 0;

		for (const channel of channels) {
			for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
				const value = Math.abs(channel[frameIndex] ?? 0);

				if (value > chunkMax) chunkMax = value;
			}
		}

		if (chunkMax > this.bucketMax) {
			this.rebucket(chunkMax);
		}

		if (this.bucketMax === 0) {
			const chunkSamples = channels.length * frames;

			this.pendingZeros += chunkSamples;
			this.totalSamples += chunkSamples;

			return;
		}

		const scale = this.bucketCount / this.bucketMax;
		const lastBucket = this.bucketCount - 1;

		for (const channel of channels) {
			for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
				const value = Math.abs(channel[frameIndex] ?? 0);
				let bucketIndex = Math.floor(value * scale);

				if (bucketIndex < 0) bucketIndex = 0;
				else if (bucketIndex > lastBucket) bucketIndex = lastBucket;

				this.buckets[bucketIndex] = (this.buckets[bucketIndex] ?? 0) + 1;
				this.totalSamples += 1;
			}
		}
	}

	finalize(): { buckets: Uint32Array; bucketMax: number; median: number } {
		if (this.cachedResult !== undefined) return this.cachedResult;

		this.finalized = true;

		if (this.totalSamples === 0 || this.bucketMax === 0) {
			this.cachedResult = { buckets: this.buckets, bucketMax: 0, median: 0 };

			return this.cachedResult;
		}

		const target = this.totalSamples / 2;
		const bucketWidth = this.bucketMax / this.bucketCount;
		let cumulative = 0;
		let median = 0;

		for (let bucketIndex = 0; bucketIndex < this.bucketCount; bucketIndex++) {
			const count = this.buckets[bucketIndex] ?? 0;
			const next = cumulative + count;

			if (next >= target) {
				const fraction = count > 0 ? (target - cumulative) / count : 0;

				median = (bucketIndex + fraction) * bucketWidth;
				break;
			}

			cumulative = next;
		}

		this.cachedResult = { buckets: this.buckets, bucketMax: this.bucketMax, median };

		return this.cachedResult;
	}

	private rebucket(newMax: number): void {
		if (this.bucketMax === 0) {
			if (this.pendingZeros > 0) {
				this.buckets[0] = (this.buckets[0] ?? 0) + this.pendingZeros;
				this.pendingZeros = 0;
			}

			this.bucketMax = newMax;

			return;
		}

		const oldBuckets = this.buckets;
		const oldMax = this.bucketMax;
		const newBuckets = new Uint32Array(this.bucketCount);
		const lastBucket = this.bucketCount - 1;
		const oldWidth = oldMax / this.bucketCount;
		const newScale = this.bucketCount / newMax;

		for (let oldIndex = 0; oldIndex < this.bucketCount; oldIndex++) {
			const count = oldBuckets[oldIndex] ?? 0;

			if (count === 0) continue;

			const center = (oldIndex + 0.5) * oldWidth;
			let newIndex = Math.floor(center * newScale);

			if (newIndex < 0) newIndex = 0;
			else if (newIndex > lastBucket) newIndex = lastBucket;

			newBuckets[newIndex] = (newBuckets[newIndex] ?? 0) + count;
		}

		this.buckets = newBuckets;
		this.bucketMax = newMax;
	}
}
