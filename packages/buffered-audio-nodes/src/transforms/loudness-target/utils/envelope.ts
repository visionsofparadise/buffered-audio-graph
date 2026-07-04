import { open, type FileHandle } from "node:fs/promises";
import { ChunkBuffer } from "@buffered-audio/core";
import type { BidirectionalIir } from "@buffered-audio/utils";

async function readFully(handle: FileHandle, target: Buffer, position: number): Promise<void> {
	let filled = 0;

	while (filled < target.length) {
		const { bytesRead } = await handle.read(target, filled, target.length - filled, position + filled);

		if (bytesRead === 0) {
			throw new Error(`readFully: unexpected EOF at byte ${position + filled}`);
		}

		filled += bytesRead;
	}
}

// Sliding-window-min primitive: https://en.wikipedia.org/wiki/Sliding_window_minimum
export function windowSamplesFromMs(smoothingMs: number, sampleRate: number): number {
	return Math.max(1, Math.round((smoothingMs * sampleRate) / 1000));
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

	await sourceBuffer.flushWrites();

	const sourcePath = sourceBuffer.tempFilePath();

	if (sourcePath === undefined) return;

	// Two reverse-stripe passes over the mono buffers' temp files replace the prior reverseBuffer
	// materialisations (reversedSource, iirForwardOrder). Reversing from-the-end flips the ragged
	// tail stripe to the front, so both passes see the exact chunk cadence — and therefore the exact
	// fp sequence — of the prior chunk-locked loops.
	const filteredReversed = new ChunkBuffer();
	const reverseScratch = new Float32Array(chunkSize);

	try {
		// Backward IIR = forward IIR over reversed time; state seeds from the source's last sample,
		// matching `applyBackwardPassInPlace`'s init rule.
		const sourceHandle = await open(sourcePath, "r");

		try {
			const backwardState = { value: 0 };
			let seeded = false;
			let endFrame = totalFrames;

			while (endFrame > 0) {
				const stripeFrames = Math.min(chunkSize, endFrame);
				const startFrame = endFrame - stripeFrames;
				const stripeBytes = Buffer.alloc(stripeFrames * 4);

				await readFully(sourceHandle, stripeBytes, startFrame * 4);

				const stripe = new Float32Array(stripeBytes.buffer, stripeBytes.byteOffset, stripeFrames);
				const reversed = reverseScratch.subarray(0, stripeFrames);

				for (let sampleIdx = 0; sampleIdx < stripeFrames; sampleIdx++) {
					reversed[sampleIdx] = stripe[stripeFrames - 1 - sampleIdx] ?? 0;
				}

				if (!seeded) {
					backwardState.value = reversed[0] ?? 0;
					seeded = true;
				}

				const filtered = iir.applyForwardPass(reversed, backwardState);

				await filteredReversed.write([filtered], sr, bd);
				endFrame = startFrame;
			}
		} finally {
			await sourceHandle.close();
		}

		await filteredReversed.flushWrites();

		const filteredPath = filteredReversed.tempFilePath();

		if (filteredPath === undefined) return;

		// Un-reverse into dest, folding the per-sample clamp into the same stripe walk.
		const filteredHandle = await open(filteredPath, "r");

		try {
			if (minHeldBuffer !== undefined) await minHeldBuffer.reset();

			let endFrame = totalFrames;

			while (endFrame > 0) {
				const stripeFrames = Math.min(chunkSize, endFrame);
				const startFrame = endFrame - stripeFrames;
				const stripeBytes = Buffer.alloc(stripeFrames * 4);

				await readFully(filteredHandle, stripeBytes, startFrame * 4);

				const stripe = new Float32Array(stripeBytes.buffer, stripeBytes.byteOffset, stripeFrames);
				const forwardOrder = reverseScratch.subarray(0, stripeFrames);

				for (let sampleIdx = 0; sampleIdx < stripeFrames; sampleIdx++) {
					forwardOrder[sampleIdx] = stripe[stripeFrames - 1 - sampleIdx] ?? 0;
				}

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
				endFrame = startFrame;
			}
		} finally {
			await filteredHandle.close();
		}

		await destBuffer.flushWrites();
	} finally {
		await filteredReversed.close();
	}
}

