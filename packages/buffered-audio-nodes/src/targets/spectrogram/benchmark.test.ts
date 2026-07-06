import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { spectrogram } from ".";
import { read } from "../../sources/read";
import { appendBenchmarkLog } from "../../utils/test-benchmark";
import { audio, binaries } from "../../utils/test-binaries";

const here = dirname(fileURLToPath(import.meta.url));
const testVoice = audio.testVoice;

const configs = [
	{ name: "spectrogram [js]", fftwAddonPath: "" },
	{ name: "spectrogram [fftw]", fftwAddonPath: binaries.fftwAddon },
];

describe("spectrogram benchmark", () => {
	for (const config of configs) {
		it(`benchmarks ${config.name}`, async () => {
			const tempSpec = resolve(tmpdir(), `ban-spec-bench-${randomBytes(8).toString("hex")}.bin`);

			try {
				const source = read(testVoice);
				const target = spectrogram(tempSpec, { fftSize: 4096, hopSize: 4096, fftwAddonPath: config.fftwAddonPath });

				source.to(target);

				const start = performance.now();
				await source.createRenderJob().render();
				const totalMs = performance.now() - start;

				const result = { name: config.name, totalMs, samplesPerSecond: 0, realTimeMultiplier: 0 };
				await appendBenchmarkLog(here, result);
			} finally {
				await unlink(tempSpec).catch(() => undefined);
			}
		}, 240_000);
	}
});
