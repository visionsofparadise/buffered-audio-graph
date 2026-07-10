import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(packageRoot, "../..");
const fixturesDir = resolve(repoRoot, "../fixtures");
const binariesDir = resolve(fixturesDir, "binaries");

const exe = process.platform === "win32" ? ".exe" : "";

export const binaries = {
	ffmpeg: resolve(binariesDir, `ffmpeg${exe}`),
	ffprobe: resolve(binariesDir, `ffprobe${exe}`),
	onnxAddon: resolve(binariesDir, "onnx_addon.node"),
	vkfftAddon: resolve(binariesDir, "vkfft_addon.node"),
	fftwAddon: resolve(binariesDir, "fftw_addon.node"),
	model1: resolve(binariesDir, "model_1.onnx"),
	model2: resolve(binariesDir, "model_2.onnx"),
	kimVocal2: resolve(binariesDir, "Kim_Vocal_2.onnx"),
	htdemucs: resolve(binariesDir, "htdemucs.onnx"),
	htdemucsData: resolve(binariesDir, "htdemucs.onnx.data"),
	dfn3: resolve(binariesDir, "dfn3.onnx"),
} as const;

export const audio = {
	testVoice: resolve(fixturesDir, "audio/test-voice.wav"),
	testVoice48k: resolve(fixturesDir, "audio/test-voice-48k.wav"),
	testMusic: resolve(fixturesDir, "audio/test-music.wav"),
} as const;

export function hasAudioFixtures(...names: Array<keyof typeof audio>): boolean {
	return names.every(name => existsSync(audio[name]));
}

export function hasBinaryFixtures(...names: Array<keyof typeof binaries>): boolean {
	return names.every(name => existsSync(binaries[name]));
}
