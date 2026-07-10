import { WaveFile } from "wavefile";

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
