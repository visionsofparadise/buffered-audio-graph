import { describe, it, expect } from "vitest";
import { runTransform } from "../../utils/test-pipeline";
import { notSilent, expectedDuration, somethingChanged, notAnomalous } from "../../utils/test-audio";
import { audio, binaries, hasAudioFixtures, hasBinaryFixtures } from "../../utils/test-binaries";
import { kimVocal2 } from ".";

const testVoice = audio.testVoice;
const testVoice48k = audio.testVoice48k;
const describeIfFixtureSet = hasBinaryFixtures("ffmpeg", "onnxAddon", "kimVocal2") ? describe : describe.skip;

describeIfFixtureSet("kim-vocal-2", () => {
	it("processes voice audio", async () => {
		const transform = kimVocal2({
			modelPath: binaries.kimVocal2,
			ffmpegPath: binaries.ffmpeg,
			onnxAddonPath: binaries.onnxAddon,

		});
		const { input, output, context } = await runTransform(testVoice, transform);

		expect(notSilent(output).pass).toBe(true);
		expect(expectedDuration(output, context.durationFrames ?? 0).pass).toBe(true);
		expect(somethingChanged(input, output).pass).toBe(true);
		expect(notAnomalous(output).pass).toBe(true);
	}, 240_000);

	// Exercises the resample path (input rate is not 44.1 kHz); passes only if the background pump/drainer pattern is correct, else ffmpeg's ~225 K stdin buffer deadlocks the segment loop.
	(hasAudioFixtures("testVoice48k") ? it : it.skip)("processes voice audio at 48 kHz (resample path)", async () => {
		const transform = kimVocal2({
			modelPath: binaries.kimVocal2,
			ffmpegPath: binaries.ffmpeg,
			onnxAddonPath: binaries.onnxAddon,
		});
		const { input, output, context } = await runTransform(testVoice48k, transform);

		expect(notSilent(output).pass).toBe(true);
		expect(expectedDuration(output, context.durationFrames ?? 0).pass).toBe(true);
		expect(somethingChanged(input, output).pass).toBe(true);
		expect(notAnomalous(output).pass).toBe(true);
	}, 240_000);
});
