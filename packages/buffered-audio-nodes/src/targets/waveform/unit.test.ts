import { randomBytes } from "node:crypto";
import { stat, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waveform } from ".";
import { read } from "../../sources/read";
import { audio } from "../../utils/test-binaries";

const testVoice = audio.testVoice;

describe("Waveform", () => {
	it("produces a non-empty output file from voice audio", async () => {
		const tempDir = join(tmpdir(), `ban-waveform-${randomBytes(8).toString("hex")}`);
		await mkdir(tempDir, { recursive: true });
		const tempOut = join(tempDir, "waveform.bin");

		try {
			const source = read(testVoice);
			const target = waveform(tempOut);
			source.to(target);
			await source.createRenderJob().render();

			const fileStat = await stat(tempOut);
			expect(fileStat.size).toBeGreaterThan(0);
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	}, 240_000);
});
