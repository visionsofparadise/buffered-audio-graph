import { OVERSAMPLE_FACTOR } from "./constants";
import type { TruePeakUpsampler } from "@buffered-audio/utils";

export function upsampleChannels(
	channels: ReadonlyArray<Float32Array>,
	upsamplers: ReadonlyArray<TruePeakUpsampler>,
	frames: number,
	scratches: Array<Float32Array>,
): Array<Float32Array> {
	const upChannels: Array<Float32Array> = [];

	for (let channelIdx = 0; channelIdx < channels.length; channelIdx++) {
		const channel = channels[channelIdx];
		const upsampler = upsamplers[channelIdx];

		if (channel === undefined || upsampler === undefined) {
			upChannels.push(new Float32Array(frames * OVERSAMPLE_FACTOR));

			continue;
		}

		const slice = channel.length === frames ? channel : channel.subarray(0, frames);
		let scratch = scratches[channelIdx];

		if (scratch === undefined || scratch.length < frames * OVERSAMPLE_FACTOR) {
			scratch = new Float32Array(frames * OVERSAMPLE_FACTOR);
			scratches[channelIdx] = scratch;
		}

		upChannels.push(upsampler.upsample(slice, scratch));
	}

	return upChannels;
}

export function writeMaxAcrossChannels(
	upChannels: ReadonlyArray<Float32Array>,
	target: Float32Array,
	length: number,
): void {
	for (let upIdx = 0; upIdx < length; upIdx++) {
		let max = 0;

		for (let channelIdx = 0; channelIdx < upChannels.length; channelIdx++) {
			const upSample = upChannels[channelIdx]?.[upIdx] ?? 0;
			const absolute = Math.abs(upSample);

			if (absolute > max) max = absolute;
		}

		target[upIdx] = max;
	}
}
