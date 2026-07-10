import { randomBytes } from "node:crypto";
import { stat, unlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spectrogram } from ".";
import { read } from "../../sources/read";
import { createTestWav } from "../../utils/test-wav";

// Self-generated input WAV (a 440 Hz sine, mono, 16-bit on disk) — no fetched fixture.
let testVoice: string;

beforeAll(async () => {
	const sampleRate = 44100;
	const frames = 2000;
	const samples = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		samples[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.5;
	}

	testVoice = join(tmpdir(), `ban-spectrogram-input-${randomBytes(8).toString("hex")}.wav`);
	await writeFile(testVoice, createTestWav(sampleRate, 1, [samples]));
});

afterAll(async () => {
	await unlink(testVoice).catch(() => undefined);
});

describe("Spectrogram", () => {
	it("produces a non-empty output file from voice audio", async () => {
		const tempDir = join(tmpdir(), `ban-spectrogram-${randomBytes(8).toString("hex")}`);
		await mkdir(tempDir, { recursive: true });
		const tempOut = join(tempDir, "spectrogram.bin");

		try {
			const source = read(testVoice);
			const target = spectrogram(tempOut);
			source.to(target);
			await source.createRenderJob().render();

			const fileStat = await stat(tempOut);
			expect(fileStat.size).toBeGreaterThan(0);
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	});
});
