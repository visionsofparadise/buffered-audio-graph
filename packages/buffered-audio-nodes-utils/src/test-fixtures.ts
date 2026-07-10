import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");
const exe = process.platform === "win32" ? ".exe" : "";

export const fixtures = {
	vkfftAddon: resolve(fixturesDir, "binaries/vkfft_addon.node"),
	fftwAddon: resolve(fixturesDir, "binaries/fftw_addon.node"),
	ffmpeg: resolve(fixturesDir, `binaries/ffmpeg${exe}`),
	testVoice: resolve(fixturesDir, "audio/test-voice.wav"),
	testVoice48k: resolve(fixturesDir, "audio/test-voice-48k.wav"),
	testMusic: resolve(fixturesDir, "audio/test-music.wav"),
} as const;

export function requireFixture(name: keyof typeof fixtures): string {
	const path = fixtures[name];

	if (!existsSync(path)) {
		console.log(`[skip] fixture not found: ${name} (${path})`);

		return "";
	}

	return path;
}
