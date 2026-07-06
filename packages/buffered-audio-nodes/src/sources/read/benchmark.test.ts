import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { read } from ".";
import { write } from "../../targets/write";
import { appendBenchmarkLog } from "../../utils/test-benchmark";
import { audio } from "../../utils/test-binaries";

const here = dirname(fileURLToPath(import.meta.url));
const testVoice = audio.testVoice;

describe("read benchmark", () => {
	it("benchmarks read", async () => {
		const tempPath = resolve(tmpdir(), `ban-read-bench-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = read(testVoice);
			const target = write(tempPath, { bitDepth: "32f" });

			source.to(target);

			const start = performance.now();
			await source.createRenderJob().render();
			const totalMs = performance.now() - start;

			const result = { name: "read", totalMs, samplesPerSecond: 0, realTimeMultiplier: 0 };
			await appendBenchmarkLog(here, result);
		} finally {
			await unlink(tempPath).catch(() => undefined);
		}
	}, 240_000);
});
