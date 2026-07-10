import { describe, it, expect } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, createTestStreamContext, runTransformStream } from "@buffered-audio/core/testing";
import { downmixMono, DownmixMonoNode, DownmixMonoStream } from ".";

function makeChunk(channelValues: Array<number>, frames = 256): Block {
	return {
		samples: channelValues.map((val) => new Float32Array(frames).fill(val)),
		offset: 0,
		sampleRate: 48000,
		bitDepth: 32,
	};
}

function applyDownmix(chunk: Block): Block {
	const stream = new DownmixMonoStream(downmixMono(), createTestStreamContext().context);
	let result: Block | undefined;

	for (const block of stream._transform(chunk)) result = block;

	if (!result) throw new Error("transform yielded nothing");

	return result;
}

describe("DownmixMonoNode", () => {
	it("has correct static metadata", () => {
		expect(DownmixMonoNode.nodeName).toBe("Downmix Mono");
	});

	it("passes mono input unchanged", () => {
		const output = applyDownmix(makeChunk([0.5]));
		expect(output.samples.length).toBe(1);
		expect(output.samples[0]![0]).toBeCloseTo(0.5, 5);
	});

	it("averages stereo to mono", () => {
		const output = applyDownmix(makeChunk([0.8, 0.4]));
		expect(output.samples.length).toBe(1);
		expect(output.samples[0]![0]).toBeCloseTo(0.6, 5);
	});

	it("averages 4 channels to mono", () => {
		const output = applyDownmix(makeChunk([0.4, 0.8, 0.2, 0.6]));
		expect(output.samples.length).toBe(1);
		expect(output.samples[0]![0]).toBeCloseTo(0.5, 5);
	});

	it("preserves frame count", () => {
		const output = applyDownmix(makeChunk([0.5, 0.5], 1024));
		expect(output.samples[0]!.length).toBe(1024);
	});

	it("handles channels with different signs correctly", () => {
		const output = applyDownmix(makeChunk([0.5, -0.5]));
		expect(output.samples[0]![0]).toBeCloseTo(0.0, 5);
	});

	it("downmixes a stereo stream to mono through the harness", async () => {
		const { blocks } = await runTransformStream(downmixMono(), [makeChunk([0.8, 0.4], 256)]);

		expect(blocks[0]!.samples.length).toBe(1);
		expect(channelSamples(blocks, 0)[0]).toBeCloseTo(0.6, 5);
	});
});
