import type { ChunkBuffer } from "@buffered-audio/core";
import { IntegratedLufsAccumulator } from "@buffered-audio/utils";

// One second's worth of frames at 44.1 kHz — a sane balance between
// per-iteration overhead and per-chunk allocation pressure when streaming
// a `ChunkBuffer` through an accumulator. Same constant is used by the
// other loudness-* measurement helpers; keep them in sync.
const CHUNK_FRAMES = 44100;

/**
 * Measure integrated loudness (BS.1770-4 / EBU R128) over a whole-file
 * `ChunkBuffer`. Streams the buffer in `CHUNK_FRAMES`-frame chunks
 * through an {@link IntegratedLufsAccumulator}, holding only one chunk
 * plus the bounded gating state in memory at any time. Constant memory
 * in source duration.
 *
 * Channel weighting defaults to 1.0 per channel (correct for mono and
 * stereo). BS.1770-4 surround weighting (Ls/Rs at 1.41) is not yet
 * supported here; if surround support becomes a requirement, surface a
 * `channelWeights` parameter and forward it through.
 *
 * Returns `-Infinity` for silent / sub-block-length signals — callers
 * must treat this as a no-op gain (the linear-shift target is undefined
 * when the input has no measurable loudness).
 */
export async function measureIntegratedLufs(buffer: ChunkBuffer, sampleRate: number): Promise<number> {
	const frames = buffer.frames;
	const channelCount = buffer.channels;

	if (frames === 0 || channelCount === 0) return -Infinity;

	const accumulator = new IntegratedLufsAccumulator(sampleRate, channelCount);

	// Rewind read cursor — defensive; the framework leaves the cursor at end-of-buffer
	// after `_process` completes, and this measurement is the first reader. Mirrors the
	// pattern in loudness-target/utils/measurement.ts.
	await buffer.reset();

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		accumulator.push(chunk.samples, chunkFrames);

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	return accumulator.finalize();
}
