import { describe, it, expect } from "vitest";
import { runTransform } from "../../utils/test-pipeline";
import { notSilent, expectedDuration, somethingChanged, notAnomalous } from "../../utils/test-audio";
import { audio, binaries, hasBinaryFixtures } from "../../utils/test-binaries";
import { dtln } from ".";

const testVoice = audio.testVoice;
const describeIfFixtureSet = hasBinaryFixtures("model1", "model2", "ffmpeg", "onnxAddon", "vkfftAddon", "fftwAddon") ? describe : describe.skip;

describeIfFixtureSet("dtln", () => {
	it("processes voice audio", async () => {
		const transform = dtln({
			modelPath1: binaries.model1,
			modelPath2: binaries.model2,
			ffmpegPath: binaries.ffmpeg,
			onnxAddonPath: binaries.onnxAddon,

			vkfftAddonPath: binaries.vkfftAddon,
			fftwAddonPath: binaries.fftwAddon,
		});
		const { input, output, context } = await runTransform(testVoice, transform);

		expect(notSilent(output).pass).toBe(true);
		expect(expectedDuration(output, context.durationFrames ?? 0).pass).toBe(true);
		expect(somethingChanged(input, output).pass).toBe(true);
		expect(notAnomalous(output).pass).toBe(true);
	}, 240_000);
});
