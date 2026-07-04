/* eslint-disable @typescript-eslint/no-non-null-assertion -- bounds-checked typed-array indexing */
import { open } from "node:fs/promises";
import { ChunkBuffer } from "./chunk-buffer";

const STRIPE_BYTES = 10 * 1024 * 1024;

export async function reverseBuffer(source: ChunkBuffer, dest?: ChunkBuffer): Promise<ChunkBuffer> {
	await source.flushWrites();

	const out = dest ?? new ChunkBuffer();
	const channels = source.channels;
	const totalFrames = source.frames;

	if (channels === 0 || totalFrames === 0) return out;

	const sourcePath = source.tempFilePath();

	if (!sourcePath) return out;

	const sampleRate = source.sampleRate;
	const bitDepth = source.bitDepth;
	const bytesPerFrame = channels * 4;
	const stripeFramesCap = Math.max(1, Math.floor(STRIPE_BYTES / bytesPerFrame));
	const handle = await open(sourcePath, "r");

	try {
		let endFrame = totalFrames;

		while (endFrame > 0) {
			const stripeFrames = Math.min(stripeFramesCap, endFrame);
			const startFrame = endFrame - stripeFrames;
			const buf = Buffer.alloc(stripeFrames * bytesPerFrame);

			await handle.read(buf, 0, buf.length, startFrame * bytesPerFrame);

			const interleaved = new Float32Array(buf.buffer, buf.byteOffset, stripeFrames * channels);
			const reversed: Array<Float32Array> = [];

			for (let ch = 0; ch < channels; ch++) reversed.push(new Float32Array(stripeFrames));

			for (let frame = 0; frame < stripeFrames; frame++) {
				const sourceBase = (stripeFrames - 1 - frame) * channels;

				for (let ch = 0; ch < channels; ch++) {
					reversed[ch]![frame] = interleaved[sourceBase + ch]!;
				}
			}

			await out.write(reversed, sampleRate, bitDepth);
			endFrame = startFrame;
		}
	} finally {
		await handle.close();
	}

	await out.flushWrites();

	return out;
}
