import { BlockBuffer } from "@buffered-audio/core";
import { SlidingWindowMaxStream, TruePeakUpsampler, linearToDb } from "@buffered-audio/utils";
import { CHUNK_FRAMES, OVERSAMPLE_FACTOR } from "./iterate";

export interface BuildBaseRateDetectionCacheArgs {
	buffer: BlockBuffer;
	sampleRate: number;
	channelCount: number;
	frames: number;
	halfWidth: number;
}

export async function buildBaseRateDetectionCache(
	args: BuildBaseRateDetectionCacheArgs,
): Promise<BlockBuffer> {
	const { buffer, sampleRate, channelCount, frames, halfWidth } = args;

	const detectionEnvelope = new BlockBuffer();

	if (frames === 0 || channelCount === 0) {
		return detectionEnvelope;
	}

	const sourceBitDepth = buffer.bitDepth;

	// Fresh per-channel BS.1770-4 polyphase upsamplers for THIS walk only — MUST NOT be shared with
	// any other upsampler set (each carries different 12-tap signal history).
	const upsamplers: Array<TruePeakUpsampler> = [];

	for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
		upsamplers.push(new TruePeakUpsampler(OVERSAMPLE_FACTOR));
	}

	const slidingWindow = new SlidingWindowMaxStream(halfWidth);
	const detectScratch4x = new Float32Array(CHUNK_FRAMES * OVERSAMPLE_FACTOR);
	const detectScratchBase = new Float32Array(CHUNK_FRAMES);
	// Converts the LINEAR pooled slider output to dB before the envelope write (see measurement.ts's toDbScratch).
	// Must grow on demand, NOT a fixed CHUNK_FRAMES: the slider's final push emits chunkFrames + halfWidth samples,
	// which can exceed CHUNK_FRAMES — a fixed scratch would truncate the tail and diverge from the accumulator.
	let dbScratch: Float32Array | null = null;
	const upsampleScratches: Array<Float32Array> = [];

	let consumedBaseFrames = 0;

	// processAndEmit leaves the cursor at end-of-buffer after _process; this caller reads from frame 0.
	await buffer.reset();

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const channels = chunk.samples;
		const chunkFrames = channels[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		const upChunkLength = chunkFrames * OVERSAMPLE_FACTOR;
		const upChannels: Array<Float32Array> = [];

		for (let channelIdx = 0; channelIdx < channels.length; channelIdx++) {
			const channel = channels[channelIdx];
			const upsampler = upsamplers[channelIdx];

			if (channel === undefined || upsampler === undefined) {
				upChannels.push(new Float32Array(upChunkLength));
				continue;
			}

			const slice = channel.length === chunkFrames ? channel : channel.subarray(0, chunkFrames);
			let scratch = upsampleScratches[channelIdx];

			if (scratch === undefined || scratch.length < chunkFrames * OVERSAMPLE_FACTOR) {
				scratch = new Float32Array(chunkFrames * OVERSAMPLE_FACTOR);
				upsampleScratches[channelIdx] = scratch;
			}

			upChannels.push(upsampler.upsample(slice, scratch));
		}

		const detect4xChunk = detectScratch4x.subarray(0, upChunkLength);

		for (let upIdx = 0; upIdx < upChunkLength; upIdx++) {
			let max = 0;

			for (let channelIdx = 0; channelIdx < upChannels.length; channelIdx++) {
				const upSample = upChannels[channelIdx]?.[upIdx] ?? 0;
				const absolute = Math.abs(upSample);

				if (absolute > max) max = absolute;
			}

			detect4xChunk[upIdx] = max;
		}

		const detectBaseChunk = detectScratchBase.subarray(0, chunkFrames);

		for (let baseIdx = 0; baseIdx < chunkFrames; baseIdx++) {
			const upOffset = baseIdx * OVERSAMPLE_FACTOR;
			const s0 = detect4xChunk[upOffset] ?? 0;
			const s1 = detect4xChunk[upOffset + 1] ?? 0;
			const s2 = detect4xChunk[upOffset + 2] ?? 0;
			const s3 = detect4xChunk[upOffset + 3] ?? 0;
			const m01 = s0 > s1 ? s0 : s1;
			const m23 = s2 > s3 ? s2 : s3;

			detectBaseChunk[baseIdx] = m01 > m23 ? m01 : m23;
		}

		consumedBaseFrames += chunkFrames;

		const isFinal = consumedBaseFrames >= frames;
		const pooled = slidingWindow.push(detectBaseChunk, isFinal);

		if (pooled.length > 0) {
			if (dbScratch === null || dbScratch.length < pooled.length) {
				dbScratch = new Float32Array(pooled.length);
			}

			const dbChunk = dbScratch.subarray(0, pooled.length);

			for (let sampleIdx = 0; sampleIdx < pooled.length; sampleIdx++) {
				dbChunk[sampleIdx] = linearToDb(pooled[sampleIdx] ?? 0);
			}

			await detectionEnvelope.write([dbChunk], sampleRate, sourceBitDepth);
		}

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	// Flush in-flight writes so downstream reset-then-read sees a consistent state.
	await detectionEnvelope.flushWrites();

	return detectionEnvelope;
}
