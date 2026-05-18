import { describe, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, appendBenchmarkLog } from "../../utils/test-benchmark";
import { audio, hasAudioFixtures } from "../../utils/test-binaries";
import { crestReduce } from ".";

// crestReduce benchmark — the de-bleed pattern (`runBenchmark` +
// `appendBenchmarkLog` → `benchmarks.log` in this node dir). Single
// normalized-lattice realization (2026-05-16 FUNDAMENTAL REFRAME — no
// `realization`). Whole-file: the node accumulates the entire input,
// runs the per-frame Abel & Smith fit + bidirectional control-trajectory
// smoothing + whole-signal never-worsen, then emits — so the timing is the
// whole-file processing cost (the `loudnessTarget` precedent), not a
// per-block streaming cost.

const here = dirname(fileURLToPath(import.meta.url));

describe("crestReduce benchmark", () => {
	it.skipIf(!hasAudioFixtures("testVoice"))("benchmarks crestReduce on voice", async () => {
		const result = await runBenchmark("crestReduce (voice)", crestReduce(), audio.testVoice);

		await appendBenchmarkLog(here, result);
	}, 900_000);

	it.skipIf(!hasAudioFixtures("testMusic"))("benchmarks crestReduce on music", async () => {
		const result = await runBenchmark("crestReduce (music)", crestReduce(), audio.testMusic);

		await appendBenchmarkLog(here, result);
	}, 900_000);
});
