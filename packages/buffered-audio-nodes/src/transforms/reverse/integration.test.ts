import { describe, expect, it } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, runTransformStream } from "@buffered-audio/core/testing";
import { reverse } from ".";

const SAMPLE_RATE = 44100;

function makeRamp(frames: number, offset = 0): Block {
	const channel = new Float32Array(frames);

	for (let i = 0; i < frames; i++) channel[i] = offset + i;

	return { samples: [channel], offset, sampleRate: SAMPLE_RATE, bitDepth: 32 };
}

describe("reverse", () => {
	it("reverses the sample order of the whole signal", async () => {
		const frames = 2000;
		const { blocks } = await runTransformStream(reverse(), [makeRamp(frames)]);
		const out = channelSamples(blocks, 0);

		expect(out.length).toBe(frames);
		expect(out[0]).toBe(frames - 1);
		expect(out[frames - 1]).toBe(0);
		for (let i = 0; i < frames; i++) expect(out[i]).toBe(frames - 1 - i);
	});

	it("reverses identically across the whole file regardless of input chunking", async () => {
		const frames = 3000;
		const single = channelSamples((await runTransformStream(reverse(), [makeRamp(frames)])).blocks, 0);
		const chunked = channelSamples(
			(await runTransformStream(reverse(), [makeRamp(1000, 0), makeRamp(2000, 1000)])).blocks,
			0,
		);

		expect(chunked.length).toBe(single.length);
		for (let i = 0; i < frames; i++) expect(chunked[i]).toBe(single[i]!);
	});

	it("emits nothing for empty input", async () => {
		const { blocks } = await runTransformStream(reverse(), []);

		expect(channelSamples(blocks, 0).length).toBe(0);
	});
});
