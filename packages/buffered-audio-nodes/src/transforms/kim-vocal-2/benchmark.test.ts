import { describe, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, appendBenchmarkLog } from "../../utils/test-benchmark";
import { audio, binaries } from "../../utils/test-binaries";
import { kimVocal2 } from ".";

const here = dirname(fileURLToPath(import.meta.url));
const testVoice = audio.testVoice;

describe("kim-vocal-2 benchmark", () => {
	it("benchmarks kim-vocal-2", async () => {
		const result = await runBenchmark(
			"kim-vocal-2",
			kimVocal2({ modelPath: binaries.kimVocal2, ffmpegPath: binaries.ffmpeg, onnxAddonPath: binaries.onnxAddon }),
			testVoice,
		);
		await appendBenchmarkLog(here, result);
	}, 240_000);
});
