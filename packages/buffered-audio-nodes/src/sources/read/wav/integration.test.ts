import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenderEvents, StreamContext } from "@buffered-audio/core";
import { ReadWavStream, readWav } from ".";
import { read } from "..";
import { write } from "../../../targets/write";
import { readToBuffer, readWavSamples } from "../../../utils/read-to-buffer";
import { createTestWav } from "../../../utils/test-wav";

// Self-generated stereo input WAV (440 Hz left / 880 Hz right, 16-bit on disk) — no fetched fixture.
let testVoice: string;

beforeAll(async () => {
	const sampleRate = 44100;
	const frames = 2000;
	const left = new Float32Array(frames);
	const right = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		left[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.5;
		right[index] = Math.sin((2 * Math.PI * 880 * index) / sampleRate) * 0.3;
	}

	testVoice = join(tmpdir(), `ban-readwav-input-${randomBytes(8).toString("hex")}.wav`);
	await writeFile(testVoice, createTestWav(sampleRate, 2, [left, right]));
});

afterAll(async () => {
	await unlink(testVoice).catch(() => undefined);
});

function renderContext(): StreamContext {
	return { events: new EventEmitter() as RenderEvents, nextStreamId: () => 0 };
}

describe("ReadWavNode", () => {
	it("reads WAV file metadata correctly", async () => {
		const node = readWav(testVoice);
		const meta = await new ReadWavStream(node, renderContext()).getMetadata();

		expect(meta.sampleRate).toBeGreaterThan(0);
		expect(meta.channels).toBeGreaterThan(0);
		expect(meta.durationFrames).toBeGreaterThan(0);
	});

	it("renders a WAV file through ReadWavNode", async () => {
		const tempOut = join(tmpdir(), `ban-readwav-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = readWav(testVoice);
			const target = write(tempOut, { bitDepth: "32f" });
			source.to(target);
			await source.createRenderJob().render();

			const result = await readWavSamples(tempOut);
			const expected = await readWavSamples(testVoice);

			expect(result.sampleRate).toBe(expected.sampleRate);
			expect(result.channels).toBe(expected.channels);
			expect(result.durationFrames).toBe(expected.durationFrames);
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	});
});

describe("ReadWavStream", () => {
	it("returns correct SourceMetadata matching the source WAV file", async () => {
		const expected = await readWavSamples(testVoice);

		const tempOut = join(tmpdir(), `ban-read-meta-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = read(testVoice);
			const target = write(tempOut, { bitDepth: "32f" });
			source.to(target);
			await source.createRenderJob().render();

			const result = await readWavSamples(tempOut);

			expect(result.sampleRate).toBe(expected.sampleRate);
			expect(result.channels).toBe(expected.channels);
			expect(result.durationFrames).toBe(expected.durationFrames);
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	});

	it("reads stereo WAV with channel selection to produce mono output", async () => {
		const info = await readWavSamples(testVoice);

		if (info.channels < 2) {
			const stereoPath = join(tmpdir(), `ban-read-stereo-${randomBytes(8).toString("hex")}.wav`);
			const monoOutPath = join(tmpdir(), `ban-read-mono-${randomBytes(8).toString("hex")}.wav`);

			try {
				const source = read(testVoice, { channels: [0] });
				const target = write(monoOutPath, { bitDepth: "32f" });
				source.to(target);
				await source.createRenderJob().render();

				const result = await readWavSamples(monoOutPath);
				expect(result.channels).toBe(1);
				expect(result.durationFrames).toBe(info.durationFrames);
			} finally {
				await unlink(stereoPath).catch(() => undefined);
				await unlink(monoOutPath).catch(() => undefined);
			}
		} else {
			const monoOutPath = join(tmpdir(), `ban-read-mono-${randomBytes(8).toString("hex")}.wav`);

			try {
				const source = read(testVoice, { channels: [0] });
				const target = write(monoOutPath, { bitDepth: "32f" });
				source.to(target);
				await source.createRenderJob().render();

				const result = await readWavSamples(monoOutPath);
				expect(result.channels).toBe(1);
				expect(result.durationFrames).toBe(info.durationFrames);

				const original = await readToBuffer(testVoice);
				const originalChunk = await original.buffer.read(original.buffer.frames);
				const originalCh0 = originalChunk.samples[0]!;
				await original.buffer.close();

				const monoResult = await readToBuffer(monoOutPath);
				const monoChunk = await monoResult.buffer.read(monoResult.buffer.frames);
				const monoCh = monoChunk.samples[0]!;
				await monoResult.buffer.close();

				const compareLength = Math.min(1000, originalCh0.length, monoCh.length);
				for (let i = 0; i < compareLength; i++) {
					expect(monoCh[i]).toBeCloseTo(originalCh0[i]!, 4);
				}
			} finally {
				await unlink(monoOutPath).catch(() => undefined);
			}
		}
	});

	it("getMetadata returns stable metadata across repeated probes", async () => {
		const source = readWav(testVoice);
		const meta = await new ReadWavStream(source, renderContext()).getMetadata();

		expect(meta.sampleRate).toBeGreaterThan(0);
		expect(meta.channels).toBeGreaterThan(0);
		expect(meta.durationFrames).toBeGreaterThan(0);

		const meta2 = await new ReadWavStream(source, renderContext()).getMetadata();
		expect(meta2.sampleRate).toBe(meta.sampleRate);
		expect(meta2.channels).toBe(meta.channels);
		expect(meta2.durationFrames).toBe(meta.durationFrames);
	});
});
