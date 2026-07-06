import { BlockBuffer } from "@buffered-audio/core";
import type { BidirectionalIir } from "@buffered-audio/utils";

// Sliding-window-min primitive: https://en.wikipedia.org/wiki/Sliding_window_minimum
export function windowSamplesFromMs(smoothingMs: number, sampleRate: number): number {
	return Math.max(1, Math.round((smoothingMs * sampleRate) / 1000));
}

// When provided, `minHeldBuffer.frames` MUST equal `sourceBuffer.frames` (read in lockstep; throws on mismatch).
export async function applyBackwardPassOverChunkBuffer(args: {
	sourceBuffer: BlockBuffer;
	destBuffer: BlockBuffer;
	iir: BidirectionalIir;
	chunkSize: number;
	minHeldBuffer?: BlockBuffer;
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

	// Backward IIR = forward IIR over reversed time. The reverse reader hands back chunkSize frames at a
	// time walking end→start, already in reverse time order — the same cadence (full chunks from the end,
	// ragged chunk last) and the same values the prior hand-rolled reverse-stripe walk produced, so the
	// fp sequence fed to the IIR is unchanged and the output stays bit-exact.
	const filteredReversed = new BlockBuffer();

	try {
		const backwardState = { value: 0 };
		let seeded = false;
		const sourceReader = await sourceBuffer.openReverseReader();

		try {
			for (;;) {
				const chunk = await sourceReader.read(chunkSize);
				const reversed = chunk.samples[0];

				if (reversed === undefined || reversed.length === 0) break;

				// State seeds from the source's last sample — the first sample the reverse reader yields —
				// matching `applyBackwardPassInPlace`'s init rule.
				if (!seeded) {
					backwardState.value = reversed[0] ?? 0;
					seeded = true;
				}

				const filtered = iir.applyForwardPass(reversed, backwardState);

				await filteredReversed.write([filtered], sr, bd);
			}
		} finally {
			await sourceReader.close();
		}

		// Un-reverse into dest, folding the per-sample clamp into the same walk. Reading the reversed
		// filtered buffer backward restores forward time order; minHeldBuffer is read forward in lockstep.
		if (minHeldBuffer !== undefined) await minHeldBuffer.reset();

		const filteredReader = await filteredReversed.openReverseReader();

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
			}
		} finally {
			await filteredReader.close();
		}

		await destBuffer.flushWrites();
	} finally {
		await filteredReversed.close();
	}
}
