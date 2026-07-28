import type * as Wavefile from "wavefile";
import wavefileExports from "wavefile/dist/wavefile";

const { WaveFile } = wavefileExports as typeof Wavefile;

export function createTestWav(
	sampleRate: number,
	channels: number,
	samples: Array<Float32Array>,
	bitDepth: "16" | "32f" = "16",
): Buffer {
	const wav = new WaveFile();

	wav.fromScratch(channels, sampleRate, "32f", samples);

	if (bitDepth === "16") wav.toBitDepth("16");

	return Buffer.from(wav.toBuffer());
}
