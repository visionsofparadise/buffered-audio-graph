import { describe, expect, it } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, runTransformStream } from "@buffered-audio/core/testing";
import { cut } from ".";

const SAMPLE_RATE = 1000;

function makeRamp(frames: number, offset = 0): Block {
	const channel = new Float32Array(frames);

	for (let i = 0; i < frames; i++) channel[i] = i;

	return { samples: [channel], offset, sampleRate: SAMPLE_RATE, bitDepth: 32 };
}

describe("cut", () => {
	it("removes a region and concatenates the surrounding audio", async () => {
		const { blocks } = await runTransformStream(cut([{ start: 1, end: 2 }]), [makeRamp(4000)]);
		const out = channelSamples(blocks, 0);

		expect(out.length).toBe(3000);
		expect(out[0]).toBe(0);
		expect(out[999]).toBe(999);
		expect(out[1000]).toBe(2000);
		expect(out[2999]).toBe(3999);
	});

	it("removes matching frames when the cut spans a chunk boundary", async () => {
		const { blocks } = await runTransformStream(cut([{ start: 1, end: 2 }]), [makeRamp(1500, 0), makeRamp(1500, 1500), makeRamp(1000, 3000)]);

		expect(channelSamples(blocks, 0).length).toBe(3000);
	});
});
