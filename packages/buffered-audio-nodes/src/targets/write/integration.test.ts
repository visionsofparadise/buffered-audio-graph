import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { write } from ".";
import { read } from "../../sources/read";
import { readWavSamples } from "../../utils/read-to-buffer";
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

	// 32-bit-float on disk so the 32f round-trip test matches to float precision
	// (a 16-bit input would differ by the reader dequantisation convention).
	testVoice = join(tmpdir(), `ban-write-input-${randomBytes(8).toString("hex")}.wav`);
	await writeFile(testVoice, createTestWav(sampleRate, 1, [samples], "32f"));
});

afterAll(async () => {
	await unlink(testVoice).catch(() => undefined);
});

describe("WriteNode", () => {
	it("round-trips a WAV file with correct duration and sample rate", async () => {
		const original = await readWavSamples(testVoice);
		const tempOut = join(tmpdir(), `ban-write-rt-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = read(testVoice);
			const target = write(tempOut, { bitDepth: "32f" });
			source.to(target);
			await source.createRenderJob().render();

			const result = await readWavSamples(tempOut);

			expect(result.sampleRate).toBe(original.sampleRate);
			expect(result.durationFrames).toBe(original.durationFrames);
			expect(result.channels).toBe(original.channels);

			const compareLength = Math.min(1000, original.durationFrames);
			for (let ch = 0; ch < original.channels; ch++) {
				const origCh = original.samples[ch]!;
				const resultCh = result.samples[ch]!;
				for (let i = 0; i < compareLength; i++) {
					expect(resultCh[i]).toBeCloseTo(origCh[i]!, 4);
				}
			}
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	});

	it("writes 16-bit WAV and produces readable output", async () => {
		const original = await readWavSamples(testVoice);
		const tempOut = join(tmpdir(), `ban-write-16-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = read(testVoice);
			const target = write(tempOut, { bitDepth: "16" });
			source.to(target);
			await source.createRenderJob().render();

			const result = await readWavSamples(tempOut);

			expect(result.sampleRate).toBe(original.sampleRate);
			expect(result.durationFrames).toBe(original.durationFrames);
			expect(result.channels).toBe(original.channels);

			const origCh0 = original.samples[0]!;
			const resultCh0 = result.samples[0]!;
			const compareLength = Math.min(1000, original.durationFrames);

			for (let i = 0; i < compareLength; i++) {
				expect(resultCh0[i]).toBeCloseTo(origCh0[i]!, 3);
			}
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	});

	it("writes 32f WAV and produces readable output", async () => {
		const original = await readWavSamples(testVoice);
		const tempOut = join(tmpdir(), `ban-write-32f-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = read(testVoice);
			const target = write(tempOut, { bitDepth: "32f" });
			source.to(target);
			await source.createRenderJob().render();

			const result = await readWavSamples(tempOut);

			expect(result.sampleRate).toBe(original.sampleRate);
			expect(result.durationFrames).toBe(original.durationFrames);
			expect(result.channels).toBe(original.channels);

			const origCh0 = original.samples[0]!;
			const resultCh0 = result.samples[0]!;
			const compareLength = Math.min(1000, original.durationFrames);

			for (let i = 0; i < compareLength; i++) {
				expect(resultCh0[i]).toBeCloseTo(origCh0[i]!, 5);
			}
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	});
});
