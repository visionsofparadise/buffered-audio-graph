import { describe, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, appendBenchmarkLog } from "../../utils/test-benchmark";
import { audio, binaries } from "../../utils/test-binaries";
import { htdemucs } from ".";

const here = dirname(fileURLToPath(import.meta.url));
const testVoice = audio.testVoice;

describe("htdemucs benchmark", () => {
	it("benchmarks htdemucs", async () => {
		const result = await runBenchmark(
			"htdemucs",
			htdemucs(binaries.htdemucs, { vocals: 1, drums: 0, bass: 0, other: 0 }, { onnxAddonPath: binaries.onnxAddon }),
			testVoice,
		);
		await appendBenchmarkLog(here, result);
	}, 240_000);
});
