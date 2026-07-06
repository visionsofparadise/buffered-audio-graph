import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WaveFile } from "wavefile";
import { read } from "./sources/read";
import { write } from "./targets/write";
import { normalize } from "./transforms/normalize";

const testDir = join(import.meta.dirname, "__test_fixtures__");

function createTestWav(sampleRate: number, channels: number, samples: Array<Float32Array>): Buffer {
	const wav = new WaveFile();
	wav.fromScratch(channels, sampleRate, "32f", samples);
	wav.toBitDepth("16");
	return Buffer.from(wav.toBuffer());
}

describe("Pipeline integration", () => {
	const inputPath = join(testDir, "test-input.wav");
	const outputPath = join(testDir, "test-output.wav");

	it("read → normalize → write pipeline normalizes to ceiling", async () => {
		const sampleRate = 44100;
		const frames = 1000;
		const peakValue = 0.5;
		const samples = new Float32Array(frames);
		for (let index = 0; index < frames; index++) {
			samples[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * peakValue;
		}

		const wavBuffer = createTestWav(sampleRate, 1, [samples]);

		await mkdir(testDir, { recursive: true });
		await writeFile(inputPath, wavBuffer);

		try {
			const source = read(inputPath);
			const norm = normalize({ ceiling: 1.0 });
			source.to(norm);
			norm.to(write(outputPath));
			await source.createRenderJob().render();

			const outputData = await readFile(outputPath);
			const outputWav = new WaveFile(new Uint8Array(outputData.buffer, outputData.byteOffset, outputData.byteLength));
			outputWav.toBitDepth("32f");
			const rawOutput = outputWav.getSamples(false, Float64Array) as unknown;
			const outputSamples = new Float32Array(rawOutput as Float64Array);

			expect(outputSamples.length).toBe(frames);

			let outputPeak = 0;
			for (let index = 0; index < outputSamples.length; index++) {
				const absolute = Math.abs(outputSamples[index] ?? 0);
				if (absolute > outputPeak) outputPeak = absolute;
			}

			expect(outputPeak).toBeGreaterThan(0.95);
			expect(outputPeak).toBeLessThanOrEqual(1.0);

			const inputRatio = (samples[10] ?? 0) / (samples[5] ?? 1);
			const outputRatio = (outputSamples[10] ?? 0) / (outputSamples[5] ?? 1);
			expect(Math.abs(inputRatio - outputRatio)).toBeLessThan(0.01);
		} finally {
			await unlink(inputPath).catch(() => undefined);
			await unlink(outputPath).catch(() => undefined);
			await rmdir(testDir).catch(() => undefined);
		}
	});
});
