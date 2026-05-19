import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type * as Wavefile from "wavefile";
import { ChunkBuffer, type SourceMetadata } from "@buffered-audio/core";

// wavefile interop: the package ships a CJS `main` (works under Node ESM, scratch
// .mjs, tsx via Node resolver) and an ESM `module` with no default export (works
// for esbuild/Vite bundling). No single ESM import statement satisfies both.
// `createRequire` resolves to the CJS entry consistently across all runtimes
// (esbuild bundle, tsup-noExternal bundle, tsx, Node ESM, vitest/Vite).
const { WaveFile } = createRequire(import.meta.url)("wavefile") as typeof Wavefile;

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
	readonly buffer: ChunkBuffer;
	readonly context: SourceMetadata;
}

export async function readToBuffer(path: string): Promise<ReadToBufferResult> {
	const { samples, sampleRate, channels, durationFrames } = await readWavSamples(path);
	const buffer = new ChunkBuffer();

	await buffer.write(samples, sampleRate);
	await buffer.flushWrites();

	return { buffer, context: { sampleRate, channels, durationFrames } };
}
