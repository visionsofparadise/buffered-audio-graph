import { readFile } from "node:fs/promises";
import type * as Wavefile from "wavefile";
import wavefileExports from "wavefile/dist/wavefile";
import { BlockBuffer, type SourceMetadata } from "@buffered-audio/core";

// Import wavefile's CJS entry by explicit path so every runtime resolves it identically and tsup `noExternal` bundles it into dist/; do NOT switch to a bare import or `createRequire` (unbundlable → leaves `wavefile` unresolved in dependency-less pacote extracts).
const { WaveFile } = wavefileExports as typeof Wavefile;

export interface WavSamples {
	readonly samples: Array<Float32Array>;
	readonly sampleRate: number;
	readonly channels: number;
	readonly durationFrames: number;
}

export async function readWavSamples(path: string): Promise<WavSamples> {
	const data = await readFile(path);
	const wav = new WaveFile(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

	wav.toBitDepth("32f");

	const fmt = wav.fmt as { sampleRate: number; numChannels: number };
	const rawSamples = wav.getSamples(false, Float64Array) as unknown;

	const sampleRate = fmt.sampleRate;
	const channels = fmt.numChannels;

	let samples: Array<Float32Array>;

	if (channels === 1) {
		samples = [new Float32Array(rawSamples as Float64Array)];
	} else {
		samples = (rawSamples as Array<Float64Array>).map((channel) => new Float32Array(channel));
	}

	const durationFrames = samples[0]?.length ?? 0;

	return { samples, sampleRate, channels, durationFrames };
}

export interface ReadToBufferResult {
	readonly buffer: BlockBuffer;
	readonly context: SourceMetadata;
}

export async function readToBuffer(path: string): Promise<ReadToBufferResult> {
	const { samples, sampleRate, channels, durationFrames } = await readWavSamples(path);
	const buffer = new BlockBuffer();

	await buffer.write(samples, sampleRate);
	await buffer.flushWrites();

	return { buffer, context: { sampleRate, channels, durationFrames } };
}
