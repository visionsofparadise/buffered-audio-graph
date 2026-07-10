import type * as Wavefile from "wavefile";
import wavefileExports from "wavefile/dist/wavefile";

// Import wavefile's CJS entry by explicit path (as read-to-buffer.ts does) so tsx and vitest resolve it identically; a bare `import { WaveFile } from "wavefile"` fails under the docs generator's tsx ESM loader, which globs this file.
const { WaveFile } = wavefileExports as typeof Wavefile;

/**
 * Build a self-contained WAV buffer for tests from the given 32-bit-float
 * channel samples. Defaults to 16-bit PCM on disk (the common fixture format);
 * pass `"32f"` when a test needs float-exact round-tripping (16-bit read paths
 * differ by a 1/32767-vs-1/32768 dequantisation convention across readers).
 * Used by the end-to-end render tests to avoid depending on fetched fixtures.
 */
export function createTestWav(sampleRate: number, channels: number, samples: Array<Float32Array>, bitDepth: "16" | "32f" = "16"): Buffer {
	const wav = new WaveFile();

	wav.fromScratch(channels, sampleRate, "32f", samples);

	if (bitDepth === "16") wav.toBitDepth("16");

	return Buffer.from(wav.toBuffer());
}
