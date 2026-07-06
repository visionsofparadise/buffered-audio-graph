import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { loudnessStats } from ".";
import { read } from "../../sources/read";
import { appendBenchmarkLog } from "../../utils/test-benchmark";
import { audio } from "../../utils/test-binaries";

const here = dirname(fileURLToPath(import.meta.url));
const testVoice = audio.testVoice;

describe("loudnessStats benchmark", () => {
	it("benchmarks loudnessStats", async () => {
		const source = read(testVoice);
		const target = loudnessStats();

		source.to(target);

		const start = performance.now();
		await source.createRenderJob().render();
		const totalMs = performance.now() - start;

		const result = { name: "loudnessStats", totalMs, samplesPerSecond: 0, realTimeMultiplier: 0 };
		await appendBenchmarkLog(here, result);
	}, 240_000);
});
