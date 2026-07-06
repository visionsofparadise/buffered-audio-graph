import { describe, it, expect } from "vitest";
import { BlockBuffer } from "@buffered-audio/core";
import { duplicateChannels, DuplicateChannelsNode } from ".";

function makeMonoChunk(value: number, frames = 256) {
	return {
		samples: [new Float32Array(frames).fill(value)],
		offset: 0,
		sampleRate: 48000,
		bitDepth: 32,
	};
}

async function applyDuplicate(node: ReturnType<typeof duplicateChannels>, chunk: { samples: Array<Float32Array>; offset: number; sampleRate: number; bitDepth: number }) {
	const stream = node.createStream();
	const buffer = new BlockBuffer();
	try {
		await stream._buffer(chunk, buffer);
		return stream._unbuffer(chunk);
	} finally {
		await buffer.close();
	}
}

describe("DuplicateChannelsNode", () => {
	it("has correct static metadata", () => {
		expect(DuplicateChannelsNode.nodeName).toBe("Duplicate Channels");
	});

	it("schema defaults to 2 output channels", () => {
		const node = duplicateChannels();
		expect(node.properties.channels).toBe(2);
	});

	it("duplicates mono to 2 channels", async () => {
		const node = duplicateChannels({ channels: 2 });
		const chunk = makeMonoChunk(0.7);
		const output = await applyDuplicate(node, chunk);
		expect(output.samples.length).toBe(2);
		expect(output.samples[0]![0]).toBeCloseTo(0.7, 5);
		expect(output.samples[1]![0]).toBeCloseTo(0.7, 5);
	});

	it("duplicates mono to 4 channels", async () => {
		const node = duplicateChannels({ channels: 4 });
		const chunk = makeMonoChunk(0.3);
		const output = await applyDuplicate(node, chunk);
		expect(output.samples.length).toBe(4);
		for (let ch = 0; ch < 4; ch++) {
			expect(output.samples[ch]![0]).toBeCloseTo(0.3, 5);
		}
	});

	it("output channels are independent copies (not shared references)", async () => {
		const node = duplicateChannels({ channels: 2 });
		const chunk = makeMonoChunk(0.5);
		const output = await applyDuplicate(node, chunk);
		const ch0 = output.samples[0]!;
		const ch1 = output.samples[1]!;
		ch0[0] = 0.99;
		expect(ch1[0]).toBeCloseTo(0.5, 5);
	});

	it("preserves sample values and frame count", async () => {
		const node = duplicateChannels({ channels: 3 });
		const chunk = makeMonoChunk(0.42, 512);
		const output = await applyDuplicate(node, chunk);
		expect(output.samples.length).toBe(3);
		expect(output.samples[0]!.length).toBe(512);
		for (let i = 0; i < 512; i++) {
			expect(output.samples[0]![i]).toBeCloseTo(0.42, 5);
		}
	});

	it("throws when input has more than 1 channel", async () => {
		const node = duplicateChannels({ channels: 2 });
		const stream = node.createStream();
		const chunk = {
			samples: [new Float32Array(256), new Float32Array(256)],
			offset: 0,
			sampleRate: 48000,
			bitDepth: 32,
		};
		const buffer = new BlockBuffer();
		try {
			await stream._buffer(chunk, buffer);
			expect(() => stream._unbuffer(chunk)).toThrow(/DuplicateChannelsNode requires exactly 1 input channel/);
		} finally {
			await buffer.close();
		}
	});
});
