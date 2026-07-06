import { describe, it, expect, vi } from "vitest";
import { readToBuffer } from "./read-to-buffer";
import { readFile } from "node:fs/promises";
import { WaveFile } from "wavefile";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();

	return {
		...actual,
		readFile: vi.fn(),
	};
});

describe("readToBuffer", () => {
	it("loads a mono WAV file into a BlockBuffer", async () => {
		const sampleRate = 44100;
		const numSamples = 100;
		const wav = new WaveFile();
		const samples = new Float64Array(numSamples);

		for (let i = 0; i < numSamples; i++) {
			samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
		}

		wav.fromScratch(1, sampleRate, "32f", samples);
		const wavBuffer = Buffer.from(wav.toBuffer());

		vi.mocked(readFile).mockResolvedValue(wavBuffer);

		const result = await readToBuffer("test.wav");

		expect(result.context.sampleRate).toBe(sampleRate);
		expect(result.context.channels).toBe(1);
		expect(result.context.durationFrames).toBe(numSamples);
		expect(result.buffer.frames).toBe(numSamples);
		expect(result.buffer.channels).toBe(1);

		const chunk = await result.buffer.read(numSamples);
		expect(chunk.samples).toHaveLength(1);
		expect(chunk.samples[0]?.length).toBe(numSamples);

		await result.buffer.close();
	});

	it("loads a stereo WAV file into a BlockBuffer", async () => {
		const sampleRate = 48000;
		const numSamples = 50;
		const wav = new WaveFile();
		const left = new Float64Array(numSamples);
		const right = new Float64Array(numSamples);

		for (let i = 0; i < numSamples; i++) {
			left[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
			right[i] = Math.sin((2 * Math.PI * 880 * i) / sampleRate);
		}

		wav.fromScratch(2, sampleRate, "32f", [left, right]);
		const wavBuffer = Buffer.from(wav.toBuffer());

		vi.mocked(readFile).mockResolvedValue(wavBuffer);

		const result = await readToBuffer("stereo.wav");

		expect(result.context.sampleRate).toBe(sampleRate);
		expect(result.context.channels).toBe(2);
		expect(result.context.durationFrames).toBe(numSamples);
		expect(result.buffer.frames).toBe(numSamples);
		expect(result.buffer.channels).toBe(2);

		const chunk = await result.buffer.read(numSamples);
		expect(chunk.samples).toHaveLength(2);

		await result.buffer.close();
	});
});
