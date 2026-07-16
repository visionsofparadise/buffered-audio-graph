import { TruePeakUpsampler, type TruePeakUpsamplingFactor } from "./true-peak-upsampler";

const DEFAULT_OVERSAMPLE_FACTOR: TruePeakUpsamplingFactor = 4;

export class TruePeakAccumulator {
	private readonly channelCount: number;
	private readonly upsamplers: ReadonlyArray<TruePeakUpsampler>;
	private upsampleScratch: Float32Array = new Float32Array(0);
	private interpolatedMax = 0;
	private rawMax = 0;
	private finalizedResult?: number;

	constructor(_sampleRate: number, channelCount: number, oversampleFactor: TruePeakUpsamplingFactor = DEFAULT_OVERSAMPLE_FACTOR) {
		if (channelCount <= 0) {
			throw new Error(`TruePeakAccumulator: channelCount must be positive, got ${channelCount}`);
		}

		this.channelCount = channelCount;

		const upsamplers: Array<TruePeakUpsampler> = [];

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			upsamplers.push(new TruePeakUpsampler(oversampleFactor));
		}

		this.upsamplers = upsamplers;
	}

	// `channels[c]` needs >= `frames` valid samples from index 0 (oversized OK); advances per-channel upsampler state as if appended contiguously.
	push(channels: ReadonlyArray<Float32Array>, frames: number): void {
		if (this.finalizedResult !== undefined) throw new Error("TruePeakAccumulator: push after finalize");

		if (channels.length !== this.channelCount) {
			throw new Error(`TruePeakAccumulator: push got ${channels.length} channels, expected ${this.channelCount}`);
		}

		if (frames <= 0) return;

		for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex++) {
			const channel = channels[channelIndex];

			if (channel === undefined || channel.length < frames) {
				throw new Error(`TruePeakAccumulator: channel ${channelIndex} has ${channel?.length ?? 0} samples, fewer than the requested ${frames}`);
			}

			const upsampler = this.upsamplers[channelIndex];

			if (upsampler === undefined) {
				throw new Error(`TruePeakAccumulator: missing upsampler for channel ${channelIndex}`);
			}

			const slice = channel.length === frames ? channel : channel.subarray(0, frames);

			for (let index = 0; index < slice.length; index++) {
				const sample = slice[index] ?? 0;
				const magnitude = sample < 0 ? -sample : sample;

				if (magnitude > this.rawMax) this.rawMax = magnitude;
			}

			if (this.upsampleScratch.length < frames * upsampler.factor) {
				this.upsampleScratch = new Float32Array(frames * upsampler.factor);
			}

			const upsampled = upsampler.upsample(slice, this.upsampleScratch);

			for (let index = 0; index < upsampled.length; index++) {
				const sample = upsampled[index] ?? 0;
				const magnitude = sample < 0 ? -sample : sample;

				if (magnitude > this.interpolatedMax) this.interpolatedMax = magnitude;
			}
		}
	}

	finalize(): number {
		if (this.finalizedResult !== undefined) return this.finalizedResult;

		for (const upsampler of this.upsamplers) {
			const flushLength = 11 * upsampler.factor;

			if (this.upsampleScratch.length < flushLength) {
				this.upsampleScratch = new Float32Array(flushLength);
			}

			const tail = upsampler.flush(this.upsampleScratch);

			for (let index = 0; index < tail.length; index++) {
				const sample = tail[index] ?? 0;
				const magnitude = sample < 0 ? -sample : sample;

				if (magnitude > this.interpolatedMax) this.interpolatedMax = magnitude;
			}
		}

		this.finalizedResult = Math.max(this.rawMax, this.interpolatedMax);

		return this.finalizedResult;
	}
}
