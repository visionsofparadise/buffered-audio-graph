import { describe, it, expect } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, createTestStreamContext, runTransformStream } from "@buffered-audio/core/testing";
import { duplicateChannels, DuplicateChannelsNode, DuplicateChannelsStream } from ".";

function makeMonoChunk(value: number, frames = 256): Block {
	return {
		samples: [new Float32Array(frames).fill(value)],
		offset: 0,
		sampleRate: 48000,
		bitDepth: 32,
	};
}

function applyDuplicate(node: DuplicateChannelsNode, chunk: Block): Block {
	const stream = new DuplicateChannelsStream(node, createTestStreamContext().context);
	let result: Block | undefined;

	for (const block of stream._transform(chunk)) result = block;

	if (!result) throw new Error("transform yielded nothing");

	return result;
}

describe("DuplicateChannelsNode", () => {
	it("has correct static metadata", () => {
		expect(DuplicateChannelsNode.nodeName).toBe("Duplicate Channels");
	});

	it("schema defaults to 2 output channels", () => {
		const node = duplicateChannels();
		expect(node.properties.channels).toBe(2);
	});

	it("duplicates mono to 2 channels", () => {
		const output = applyDuplicate(duplicateChannels({ channels: 2 }), makeMonoChunk(0.7));
		expect(output.samples.length).toBe(2);
		expect(output.samples[0]![0]).toBeCloseTo(0.7, 5);
		expect(output.samples[1]![0]).toBeCloseTo(0.7, 5);
	});

	it("duplicates mono to 4 channels", () => {
		const output = applyDuplicate(duplicateChannels({ channels: 4 }), makeMonoChunk(0.3));
		expect(output.samples.length).toBe(4);
		for (let ch = 0; ch < 4; ch++) {
			expect(output.samples[ch]![0]).toBeCloseTo(0.3, 5);
		}
	});

	it("output channels are independent copies (not shared references)", () => {
		const output = applyDuplicate(duplicateChannels({ channels: 2 }), makeMonoChunk(0.5));
		const ch0 = output.samples[0]!;
		const ch1 = output.samples[1]!;
		ch0[0] = 0.99;
		expect(ch1[0]).toBeCloseTo(0.5, 5);
	});

	it("preserves sample values and frame count", () => {
		const output = applyDuplicate(duplicateChannels({ channels: 3 }), makeMonoChunk(0.42, 512));
		expect(output.samples.length).toBe(3);
		expect(output.samples[0]!.length).toBe(512);
		for (let i = 0; i < 512; i++) {
			expect(output.samples[0]![i]).toBeCloseTo(0.42, 5);
		}
	});

	it("throws when input has more than 1 channel", () => {
		const stream = new DuplicateChannelsStream(duplicateChannels({ channels: 2 }), createTestStreamContext().context);
		const chunk: Block = {
			samples: [new Float32Array(256), new Float32Array(256)],
			offset: 0,
			sampleRate: 48000,
			bitDepth: 32,
		};

		expect(() => Array.from(stream._transform(chunk))).toThrow(/DuplicateChannelsNode requires exactly 1 input channel/);
	});

	it("duplicates a mono stream through the harness", async () => {
		const { blocks } = await runTransformStream(duplicateChannels({ channels: 3 }), [makeMonoChunk(0.7, 256)]);

		expect(blocks[0]!.samples.length).toBe(3);
		expect(channelSamples(blocks, 0)[0]).toBeCloseTo(0.7, 5);
		expect(channelSamples(blocks, 2)[0]).toBeCloseTo(0.7, 5);
	});
});
