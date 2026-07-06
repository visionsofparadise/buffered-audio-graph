import { BlockBuffer } from "./block-buffer";

const STRIPE_BYTES = 10 * 1024 * 1024;

export async function reverseBuffer(source: BlockBuffer, dest?: BlockBuffer): Promise<BlockBuffer> {
	const out = dest ?? new BlockBuffer();
	const channels = source.channels;
	const totalFrames = source.frames;

	// Early-out before any bytesPerFrame arithmetic — with channels === 0 the cap below divides by zero.
	if (channels === 0 || totalFrames === 0) return out;

	const sampleRate = source.sampleRate;
	const bitDepth = source.bitDepth;
	const bytesPerFrame = channels * 4;
	const stripeFramesCap = Math.max(1, Math.floor(STRIPE_BYTES / bytesPerFrame));

	// openReverseReader() flushes pending writes and yields chunks already reversed + deinterleaved,
	// so we write each straight to the destination. Order-preserving appends make the output bytes
	// identical regardless of read-chunk size.
	const reader = await source.openReverseReader();

	try {
		for (;;) {
			const chunk = await reader.read(stripeFramesCap);
			const frames = chunk.samples[0]?.length ?? 0;

			if (frames === 0) break;

			await out.write(chunk.samples, sampleRate, bitDepth);
		}
	} finally {
		await reader.close();
	}

	await out.flushWrites();

	return out;
}
