import { BlockBuffer } from "@buffered-audio/core";
import type { BidirectionalIir } from "@buffered-audio/utils";

export function windowSamplesFromMs(smoothingMs: number, sampleRate: number): number {
	return Math.max(1, Math.round((smoothingMs * sampleRate) / 1000));
}

export async function applyBackwardPassOverChunkBuffer(args: {
	sourceBuffer: BlockBuffer;
	destBuffer: BlockBuffer;
	iir: BidirectionalIir;
	chunkSize: number;
	minHeldBuffer?: BlockBuffer;
	progress?: (done: number, total: number) => void;
}): Promise<void> {
	const { sourceBuffer, destBuffer, iir, chunkSize, minHeldBuffer, progress } = args;
	const totalFrames = sourceBuffer.frames;
	const totalWork = totalFrames * 2;

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

	const filteredReversed = new BlockBuffer();

	try {
		const backwardState = { value: 0 };
		let seeded = false;
		let filteredFrames = 0;
		const sourceReader = await sourceBuffer.openReverseReader();

		try {
			for (;;) {
				const chunk = await sourceReader.read(chunkSize);
				const reversed = chunk.samples[0];

				if (reversed === undefined || reversed.length === 0) break;

				if (!seeded) {
					backwardState.value = reversed[0] ?? 0;
					seeded = true;
				}

				const filtered = iir.applyForwardPass(reversed, backwardState);

				await filteredReversed.write([filtered], sr, bd);
				filteredFrames += reversed.length;
				progress?.(filteredFrames, totalWork);
			}
		} finally {
			await sourceReader.close();
		}

		if (minHeldBuffer !== undefined) await minHeldBuffer.reset();

		const filteredReader = await filteredReversed.openReverseReader();
		let restoredFrames = 0;

		try {
			for (;;) {
				const chunk = await filteredReader.read(chunkSize);
				const forwardOrder = chunk.samples[0];

				if (forwardOrder === undefined || forwardOrder.length === 0) break;

				const stripeFrames = forwardOrder.length;

				if (minHeldBuffer !== undefined) {
					const minChunk = await minHeldBuffer.read(stripeFrames);
					const minData = minChunk.samples[0];

					if (minData?.length !== stripeFrames) {
						throw new Error(
							`applyBackwardPassOverChunkBuffer: minHeldBuffer returned ${minData?.length ?? 0} samples; expected ${stripeFrames}`,
						);
					}

					for (let sampleIdx = 0; sampleIdx < stripeFrames; sampleIdx++) {
						const iirValue = forwardOrder[sampleIdx] ?? 0;
						const minValue = minData[sampleIdx] ?? 0;

						forwardOrder[sampleIdx] = iirValue < minValue ? iirValue : minValue;
					}
				}

				await destBuffer.write([forwardOrder], sr, bd);
				restoredFrames += stripeFrames;
				progress?.(totalFrames + restoredFrames, totalWork);
			}
		} finally {
			await filteredReader.close();
		}

		await destBuffer.flushWrites();
	} finally {
		await filteredReversed.close();
	}
}
