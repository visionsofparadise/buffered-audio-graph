import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { waveform } from ".";
import { read } from "../../sources/read";
import { appendBenchmarkLog } from "../../utils/test-benchmark";
import { audio } from "../../utils/test-binaries";

const here = dirname(fileURLToPath(import.meta.url));
const testVoice = audio.testVoice;

describe("waveform benchmark", () => {
	it("benchmarks waveform", async () => {
		const tempPath = resolve(tmpdir(), `ban-waveform-bench-${randomBytes(8).toString("hex")}.bin`);

		try {
			const source = read(testVoice);
			const target = waveform(tempPath);

			source.to(target);

			const start = performance.now();
			await source.createRenderJob().render();
			const totalMs = performance.now() - start;

			const result = { name: "waveform", totalMs, samplesPerSecond: 0, realTimeMultiplier: 0 };
			await appendBenchmarkLog(here, result);
		} finally {
			await unlink(tempPath).catch(() => undefined);
		}
	}, 240_000);
});
