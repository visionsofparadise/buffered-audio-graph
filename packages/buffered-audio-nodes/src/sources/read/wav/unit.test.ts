import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReadWavNode, readWav } from ".";
import { read } from "..";
import { write } from "../../../targets/write";
import { readToBuffer, readWavSamples } from "../../../utils/read-to-buffer";
import { audio } from "../../../utils/test-binaries";

const testVoice = audio.testVoice;

describe("ReadWavNode", () => {
	it("creates a ReadWavNode via readWav convenience function", () => {
		const node = readWav("test.wav");

		expect(node).toBeInstanceOf(ReadWavNode);
	});

	it("creates a ReadWavNode with channel selection", () => {
		const node = readWav("test.wav", { channels: [0] });

		expect(node).toBeInstanceOf(ReadWavNode);
	});

	it("reads WAV file metadata correctly", async () => {
		const node = readWav(testVoice);
		const meta = await node.getMetadata();

		expect(meta.sampleRate).toBeGreaterThan(0);
		expect(meta.channels).toBeGreaterThan(0);
		expect(meta.durationFrames).toBeGreaterThan(0);
	}, 240_000);

	it("renders a WAV file through ReadWavNode", async () => {
		const tempOut = join(tmpdir(), `ban-readwav-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = readWav(testVoice);
			const target = write(tempOut, { bitDepth: "32f" });
			source.to(target);
			await source.render();

			const result = await readWavSamples(tempOut);
			const expected = await readWavSamples(testVoice);

			expect(result.sampleRate).toBe(expected.sampleRate);
			expect(result.channels).toBe(expected.channels);
			expect(result.durationFrames).toBe(expected.durationFrames);
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	}, 240_000);

	it("clones with overrides", () => {
		const node = readWav("test.wav");
		const cloned = node.clone({ path: "other.wav" });

		expect(cloned).toBeInstanceOf(ReadWavNode);
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
			await source.render();

			const result = await readWavSamples(tempOut);

			expect(result.sampleRate).toBe(expected.sampleRate);
			expect(result.channels).toBe(expected.channels);
			expect(result.durationFrames).toBe(expected.durationFrames);
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	}, 240_000);

	it("reads stereo WAV with channel selection to produce mono output", async () => {
		const info = await readWavSamples(testVoice);

		if (info.channels < 2) {
			const stereoPath = join(tmpdir(), `ban-read-stereo-${randomBytes(8).toString("hex")}.wav`);
			const monoOutPath = join(tmpdir(), `ban-read-mono-${randomBytes(8).toString("hex")}.wav`);

			try {
				const source = read(testVoice, { channels: [0] });
				const target = write(monoOutPath, { bitDepth: "32f" });
				source.to(target);
				await source.render();

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
				await source.render();

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
	}, 240_000);

	it("getMetadata returns metadata without side effects on the node", async () => {
		const source = read(testVoice);
		const meta = await source.getMetadata();

		expect(meta.sampleRate).toBeGreaterThan(0);
		expect(meta.channels).toBeGreaterThan(0);
		expect(meta.durationFrames).toBeGreaterThan(0);

		const meta2 = await source.getMetadata();
		expect(meta2.sampleRate).toBe(meta.sampleRate);
		expect(meta2.channels).toBe(meta.channels);
		expect(meta2.durationFrames).toBe(meta.durationFrames);
	}, 240_000);
});
