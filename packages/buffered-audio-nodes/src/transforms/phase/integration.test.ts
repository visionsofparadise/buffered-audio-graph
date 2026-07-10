import { describe, expect, it } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, runTransformStream } from "@buffered-audio/core/testing";
import { phase } from ".";

const SAMPLE_RATE = 44100;

function makeBlock(values: Array<number>, offset = 0): Block {
	return { samples: [Float32Array.from(values)], offset, sampleRate: SAMPLE_RATE, bitDepth: 32 };
}

describe("phase", () => {
	it("inverts every sample by default", async () => {
		const input = [0.1, -0.4, 0.7, -0.2];
		const { blocks } = await runTransformStream(phase({ invert: true }), [makeBlock(input)]);
		const out = channelSamples(blocks, 0);

		expect(out.length).toBe(input.length);
		for (let i = 0; i < input.length; i++) expect(out[i]).toBeCloseTo(-input[i]!, 6);
	});

	it("passes the signal through when invert is disabled and no angle is set", async () => {
		const input = [0.3, -0.5, 0.9];
		const out = channelSamples((await runTransformStream(phase({ invert: false }), [makeBlock(input)])).blocks, 0);

		for (let i = 0; i < input.length; i++) expect(out[i]).toBeCloseTo(input[i]!, 6);
	});
});
