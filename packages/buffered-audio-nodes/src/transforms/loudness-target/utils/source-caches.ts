import { BlockBuffer } from "@buffered-audio/core";
import { SlidingWindowMaxStream, TruePeakUpsampler, linearToDb } from "@buffered-audio/utils";
import { CHUNK_FRAMES, OVERSAMPLE_FACTOR } from "./constants";
import { upsampleChannels, writeMaxAcrossChannels } from "./upsample";

export interface BuildBaseRateDetectionCacheArgs {
	buffer: BlockBuffer;
	temporaryDirectory: string;
	sampleRate: number;
	channelCount: number;
	frames: number;
	halfWidth: number;
}

export async function buildBaseRateDetectionCache(args: BuildBaseRateDetectionCacheArgs): Promise<BlockBuffer> {
	const { buffer, temporaryDirectory, sampleRate, channelCount, frames, halfWidth } = args;

	const detectionEnvelope = new BlockBuffer(temporaryDirectory);

	if (frames === 0 || channelCount === 0) {
		return detectionEnvelope;
	}

	const sourceBitDepth = buffer.bitDepth;

	const upsamplers: Array<TruePeakUpsampler> = [];

	for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
		upsamplers.push(new TruePeakUpsampler(OVERSAMPLE_FACTOR));
	}

	const slidingWindow = new SlidingWindowMaxStream(halfWidth);
	const detectScratch4x = new Float32Array(CHUNK_FRAMES * OVERSAMPLE_FACTOR);
	const detectScratchBase = new Float32Array(CHUNK_FRAMES);
	let dbScratch: Float32Array | null = null;
	const upsampleScratches: Array<Float32Array> = [];

	let consumedBaseFrames = 0;

	await buffer.reset();

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const channels = chunk.samples;
		const chunkFrames = channels[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		const upChunkLength = chunkFrames * OVERSAMPLE_FACTOR;
		const upChannels = upsampleChannels(channels, upsamplers, chunkFrames, upsampleScratches);
		const detect4xChunk = detectScratch4x.subarray(0, upChunkLength);

		writeMaxAcrossChannels(upChannels, detect4xChunk, upChunkLength);

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

	await detectionEnvelope.flushWrites();

	return detectionEnvelope;
}
