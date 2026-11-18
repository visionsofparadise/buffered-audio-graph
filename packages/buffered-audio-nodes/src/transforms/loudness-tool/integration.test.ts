import { describe, expect, it } from "vitest";
import type { Block } from "@buffered-audio/core";
import {
	blockFromSamples,
	channelSamples,
	createTestSetupContext,
	createTestStreamContext,
	drainBlocks,
	readableFrom,
} from "@buffered-audio/core/testing";
import { readWavSamples } from "../../utils/read-to-buffer";
import { audio, binaries, hasAudioFixtures, hasBinaryFixtures } from "../../utils/test-binaries";
import { loudnessTool, LoudnessToolNode, LoudnessToolStream } from ".";

const BLOCK_FRAMES = 4096;

const describeIfFixtures =
	hasBinaryFixtures("loudnessTool") && hasAudioFixtures("testVoice") ? describe : describe.skip;

async function stereoVoiceBlocks(): Promise<{ readonly blocks: Array<Block>; readonly sampleRate: number }> {
	const { samples, sampleRate, durationFrames } = await readWavSamples(audio.testVoice);
	const voice = samples[0];

	if (!voice) throw new Error("test voice has no channel");

	const quieter = voice.map((sample) => sample * 0.5);
	const blocks: Array<Block> = [];

	for (let offset = 0; offset < durationFrames; offset += BLOCK_FRAMES) {
		const end = Math.min(offset + BLOCK_FRAMES, durationFrames);

		blocks.push(blockFromSamples([voice.slice(offset, end), quieter.slice(offset, end)], offset, { sampleRate }));
	}

	return { blocks, sampleRate };
}

async function run(
	args: Array<string> | LoudnessToolNode,
	input: Array<Block>,
	sampleRate: number,
): Promise<{ readonly output: Array<Block>; readonly contextSampleRate: number }> {
	const node = Array.isArray(args) ? loudnessTool({ loudnessToolPath: binaries.loudnessTool, args }) : args;
	const stream = new LoudnessToolStream(node, createTestStreamContext().context);
	const context = createTestSetupContext({ sourceSampleRate: sampleRate, sampleRate });

	stream._setup(context);

	const output = await drainBlocks(stream._pipe(readableFrom(input)));

	return { output, contextSampleRate: context.sampleRate };
}

function frameCount(blocks: Array<Block>): number {
	return blocks.reduce((total, block) => total + (block.samples[0]?.length ?? 0), 0);
}

describeIfFixtures("LoudnessToolStream against the loudness-tool binary", () => {
	it("keeps the frame count, sample rate and channels through lufs-norm, and changes the signal", async () => {
		const { blocks, sampleRate } = await stereoVoiceBlocks();
		const { output, contextSampleRate } = await run(["lufs-norm", "--lufs", "-23"], blocks, sampleRate);

		expect(frameCount(output)).toBe(frameCount(blocks));
		expect(contextSampleRate).toBe(sampleRate);
		expect(output.every((block) => block.sampleRate === sampleRate && block.samples.length === 2)).toBe(true);

		const input = channelSamples(blocks, 0);
		const processed = channelSamples(output, 0);
		let maxDifference = 0;

		for (let index = 0; index < input.length; index++) {
			maxDifference = Math.max(maxDifference, Math.abs((processed[index] ?? 0) - (input[index] ?? 0)));
		}

		expect(maxDifference).toBeGreaterThan(1e-3);
	}, 60_000);

	it("keeps the frame count through crest", async () => {
		const { blocks, sampleRate } = await stereoVoiceBlocks();
		const { output } = await run(["crest"], blocks, sampleRate);

		expect(frameCount(output)).toBe(frameCount(blocks));
	}, 60_000);

	it("fails with loudness-tool's stderr when it rejects its options", async () => {
		const { blocks, sampleRate } = await stereoVoiceBlocks();

		await expect(run(["lufs-norm", "--lufs", "5"], blocks, sampleRate)).rejects.toThrow(
			/^loudness-tool exited 1: .*lufs must be in \[-50, 0\]/s,
		);
	}, 60_000);

	it("rejects -V1, and fails on its version text if validation is bypassed", async () => {
		expect(() => loudnessTool({ loudnessToolPath: binaries.loudnessTool, args: ["lufs-norm", "-V1"] })).toThrow(
			'args must not contain \\"-V1\\"',
		);

		const bypassed = loudnessTool({ loudnessToolPath: binaries.loudnessTool, args: ["lufs-norm"] });

		bypassed.properties = { ...bypassed.properties, args: ["lufs-norm", "-V1"] };

		const { blocks, sampleRate } = await stereoVoiceBlocks();

		await expect(run(bypassed, blocks, sampleRate)).rejects.toThrow('Not a WAV stream (first bytes "0.1.")');
	}, 60_000);
});
