import { ChunkBuffer, reverseBuffer } from "@buffered-audio/core";
import { BidirectionalIir, linearToDb, slidingWindowMax } from "@buffered-audio/utils";
import { type Anchors, gainDbAt } from "./curve";

// Sliding-window-min primitive: https://en.wikipedia.org/wiki/Sliding_window_minimum
export function windowSamplesFromMs(smoothingMs: number, sampleRate: number): number {
	return Math.max(1, Math.round((smoothingMs * sampleRate) / 1000));
}

// Legacy equivalence reference; production path is streamCurveAndForwardIir + applyBackwardPassOverChunkBuffer.
export function peakRespectingEnvelope(
	detection: Float32Array,
	anchors: Anchors,
	smoothingMs: number,
	sampleRate: number,
): Float32Array {
	const length = detection.length;

	if (length === 0) return new Float32Array(0);

	const halfWidth = windowSamplesFromMs(smoothingMs, sampleRate);
	const detectionWindow = slidingWindowMax(detection, halfWidth);
	const gWindow = new Float32Array(length);

	for (let sampleIdx = 0; sampleIdx < length; sampleIdx++) {
		const levelDb = linearToDb(detectionWindow[sampleIdx] ?? 0);
		const gainDb = gainDbAt(levelDb, anchors);

		gWindow[sampleIdx] = Math.pow(10, gainDb / 20);
	}

	const iir = new BidirectionalIir({ smoothingMs, sampleRate });

	return iir.applyBidirectional(gWindow);
}

// When provided, `minHeldBuffer.frames` MUST equal `sourceBuffer.frames` (read in lockstep; throws on mismatch).
export async function applyBackwardPassOverChunkBuffer(args: {
	sourceBuffer: ChunkBuffer;
	destBuffer: ChunkBuffer;
	iir: BidirectionalIir;
	chunkSize: number;
	minHeldBuffer?: ChunkBuffer;
}): Promise<void> {
	const { sourceBuffer, destBuffer, iir, chunkSize, minHeldBuffer } = args;
	const totalFrames = sourceBuffer.frames;

	if (totalFrames === 0) return;
	if (chunkSize <= 0) {
		throw new Error(`applyBackwardPassOverChunkBuffer: chunkSize must be > 0 (got ${chunkSize})`);
	}

	if (minHeldBuffer !== undefined && minHeldBuffer.frames !== totalFrames) {
		throw new Error(
			`applyBackwardPassOverChunkBuffer: minHeldBuffer.frames (${minHeldBuffer.frames}) must equal sourceBuffer.frames (${totalFrames})`,
		);
	}

	const sr = sourceBuffer.sampleRate;
	const bd = sourceBuffer.bitDepth;

	const reversedSource = await reverseBuffer(sourceBuffer);

	const filteredReversed = new ChunkBuffer();
	const iirForwardOrder = minHeldBuffer === undefined ? undefined : new ChunkBuffer();

	try {
		await reversedSource.reset();

		// Seed backward state with the first sample of the reversed source (= original's last sample),
		// matching `applyBackwardPassInPlace`'s init rule.
		const seedChunk = await reversedSource.read(1);
		const backwardState = { value: seedChunk.samples[0]?.[0] ?? 0 };

		await reversedSource.reset();

		for (;;) {
			const chunk = await reversedSource.read(chunkSize);
			const data = chunk.samples[0];
			const chunkLength = data?.length ?? 0;

			if (data === undefined || chunkLength === 0) break;

			const filtered = iir.applyForwardPass(data, backwardState);

			await filteredReversed.write([filtered], sr, bd);

			if (chunkLength < chunkSize) break;
		}

		await filteredReversed.flushWrites();

		if (iirForwardOrder === undefined) {
			await reverseBuffer(filteredReversed, destBuffer);
		} else {
			await reverseBuffer(filteredReversed, iirForwardOrder);
			await iirForwardOrder.flushWrites();

			await iirForwardOrder.reset();
			await minHeldBuffer!.reset();

			for (;;) {
				const iirChunk = await iirForwardOrder.read(chunkSize);
				const iirData = iirChunk.samples[0];
				const chunkLength = iirData?.length ?? 0;

				if (iirData === undefined || chunkLength === 0) break;

				const minChunk = await minHeldBuffer!.read(chunkLength);
				const minData = minChunk.samples[0];

				if (minData?.length !== chunkLength) {
					throw new Error(
						`applyBackwardPassOverChunkBuffer: minHeldBuffer returned ${minData?.length ?? 0} samples; expected ${chunkLength}`,
					);
				}

				const clamped = new Float32Array(chunkLength);

				for (let sampleIdx = 0; sampleIdx < chunkLength; sampleIdx++) {
					const iirValue = iirData[sampleIdx] ?? 0;
					const minValue = minData[sampleIdx] ?? 0;

					clamped[sampleIdx] = iirValue < minValue ? iirValue : minValue;
				}

				await destBuffer.write([clamped], sr, bd);

				if (chunkLength < chunkSize) break;
			}

			await destBuffer.flushWrites();
		}
	} finally {
		await reversedSource.close();
		await filteredReversed.close();
		if (iirForwardOrder !== undefined) await iirForwardOrder.close();
	}
}

