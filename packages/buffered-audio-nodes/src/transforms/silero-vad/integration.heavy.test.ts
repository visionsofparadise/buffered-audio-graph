import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sileroVad } from ".";
import { readWavSamples } from "../../utils/read-to-buffer";
import { expectedDuration, notAnomalous, notSilent } from "../../utils/test-audio";
import { audio, binaries, hasAudioFixtures, hasBinaryFixtures } from "../../utils/test-binaries";
import { runTransform } from "../../utils/test-pipeline";
import { createTestWav } from "../../utils/test-wav";

const describeIfFixtureSet =
	hasBinaryFixtures("sileroVad", "ffmpeg", "onnxAddon") && hasAudioFixtures("testVoice") ? describe : describe.skip;

const NOISE_DBFS = -50;
const LEAD_SECONDS = 2;
const TAIL_SECONDS = 2;
const FADE_GUARD_SECONDS = 0.2;
const ATTENUATION_DB = -40;
const ATTENUATION_TOLERANCE_DB = 3;
const VOICE_PASSTHROUGH_FRACTION = 0.8;

function createUnitRandom(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state += 0x6d2b79f5;
		let mixed = state;

		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

function createNoise(frames: number, targetRms: number, seed: number): Float32Array {
	const random = createUnitRandom(seed);
	const noise = new Float32Array(frames);
	let sumSquares = 0;

	for (let index = 0; index < frames; index++) {
		const sample = random() * 2 - 1;

		noise[index] = sample;
		sumSquares += sample * sample;
	}

	const rms = Math.sqrt(sumSquares / Math.max(frames, 1));
	const scale = rms === 0 ? 0 : targetRms / rms;

	for (let index = 0; index < frames; index++) {
		noise[index] = (noise[index] ?? 0) * scale;
	}

	return noise;
}

function regionRms(samples: Float32Array, startFrame: number, endFrame: number): number {
	let sumSquares = 0;
	const length = Math.max(endFrame - startFrame, 0);

	for (let index = startFrame; index < endFrame; index++) {
		const sample = samples[index] ?? 0;

		sumSquares += sample * sample;
	}

	return Math.sqrt(sumSquares / Math.max(length, 1));
}

function dbOf(ratio: number): number {
	if (ratio <= 0) return -Infinity;

	return 20 * Math.log10(ratio);
}

describeIfFixtureSet("silero-vad", () => {
	it("gates a constructed noise-floor-plus-voice input", async () => {
		const voice = await readWavSamples(audio.testVoice);
		const voiceSamples = voice.samples[0];

		if (voiceSamples === undefined) throw new Error("test-voice.wav has no samples");

		const sampleRate = voice.sampleRate;
		const leadFrames = Math.round(LEAD_SECONDS * sampleRate);
		const tailFrames = Math.round(TAIL_SECONDS * sampleRate);
		const totalFrames = leadFrames + voiceSamples.length + tailFrames;
		const noise = createNoise(totalFrames, 10 ** (NOISE_DBFS / 20), 20260822);
		const constructed = new Float32Array(totalFrames);

		constructed.set(noise);

		for (let index = 0; index < voiceSamples.length; index++) {
			constructed[leadFrames + index] = (constructed[leadFrames + index] ?? 0) + (voiceSamples[index] ?? 0);
		}

		const inputPath = join(tmpdir(), `silero-vad-${randomBytes(8).toString("hex")}.wav`);

		await writeFile(inputPath, createTestWav(sampleRate, 1, [constructed], "32f"));

		try {
			const transform = sileroVad({
				modelPath: binaries.sileroVad,
				ffmpegPath: binaries.ffmpeg,
				onnxAddonPath: binaries.onnxAddon,
			});
			const { input, output, context } = await runTransform(inputPath, transform);
			const inputChannel = input[0];
			const outputChannel = output[0];

			expect(notSilent(output).pass).toBe(true);
			expect(expectedDuration(output, context.durationFrames ?? 0).pass).toBe(true);
			expect(notAnomalous(output).pass).toBe(true);

			if (inputChannel === undefined || outputChannel === undefined) {
				throw new Error("expected mono input and output");
			}

			const guardFrames = Math.round(FADE_GUARD_SECONDS * sampleRate);
			const leadEnd = leadFrames - guardFrames;
			const tailStart = leadFrames + voiceSamples.length + guardFrames;
			const leadReductionDb = dbOf(regionRms(outputChannel, 0, leadEnd) / regionRms(inputChannel, 0, leadEnd));
			const tailReductionDb = dbOf(
				regionRms(outputChannel, tailStart, totalFrames) / regionRms(inputChannel, tailStart, totalFrames),
			);

			expect(leadReductionDb).toBeGreaterThanOrEqual(ATTENUATION_DB - ATTENUATION_TOLERANCE_DB);
			expect(leadReductionDb).toBeLessThanOrEqual(ATTENUATION_DB + ATTENUATION_TOLERANCE_DB);
			expect(tailReductionDb).toBeGreaterThanOrEqual(ATTENUATION_DB - ATTENUATION_TOLERANCE_DB);
			expect(tailReductionDb).toBeLessThanOrEqual(ATTENUATION_DB + ATTENUATION_TOLERANCE_DB);

			const voiceStart = leadFrames + guardFrames;
			const voiceEnd = leadFrames + voiceSamples.length - guardFrames;
			const speechFloor = 10 ** (NOISE_DBFS / 20) * 10;
			let identical = 0;
			let compared = 0;

			for (let index = voiceStart; index < voiceEnd; index++) {
				if (Math.abs(inputChannel[index] ?? 0) < speechFloor) continue;

				compared += 1;

				if (outputChannel[index] === inputChannel[index]) identical += 1;
			}

			expect(compared).toBeGreaterThan(0);
			expect(identical / compared).toBeGreaterThanOrEqual(VOICE_PASSTHROUGH_FRACTION);
		} finally {
			try {
				await unlink(inputPath);
			} catch (error) {
				void error;
			}
		}
	}, 240_000);
});
