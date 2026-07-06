import { describe, it, expect } from "vitest";
import { BlockBuffer } from "@buffered-audio/core";
import { gain, GainNode } from ".";

function makeStereoChunk(leftValue: number, rightValue: number, frames = 512): { samples: [Float32Array, Float32Array]; offset: number; sampleRate: number; bitDepth: number } {
	const left = new Float32Array(frames).fill(leftValue);
	const right = new Float32Array(frames).fill(rightValue);
	return { samples: [left, right], offset: 0, sampleRate: 48000, bitDepth: 32 };
}

describe("GainNode", () => {
	it("has correct static metadata", () => {
		expect(GainNode.nodeName).toBe("Gain");
		expect(GainNode.schema).toBe(GainNode.schema);
	});

	it("schema defaults to 0 dB gain", () => {
		const node = gain();
		expect(node.properties.gain).toBe(0);
	});

	it("passes signal unchanged at 0 dB", async () => {
		const node = gain({ gain: 0 });
		const stream = node.createStream();
		const buffer = new BlockBuffer();
		const chunk = makeStereoChunk(0.5, -0.5);

		try {
			await stream._buffer(chunk, buffer);
			const output = stream._unbuffer(chunk);

			for (let i = 0; i < 512; i++) {
				expect(output.samples[0]![i]).toBeCloseTo(0.5, 5);
				expect(output.samples[1]![i]).toBeCloseTo(-0.5, 5);
			}
		} finally {
			await buffer.close();
		}
	});

	it("amplifies signal by 6 dB (~factor 2)", async () => {
		const node = gain({ gain: 6 });
		const stream = node.createStream();
		const buffer = new BlockBuffer();
		const chunk = makeStereoChunk(0.25, 0.25);

		try {
			await stream._buffer(chunk, buffer);
			const output = stream._unbuffer(chunk);

			expect(output.samples[0]![0]).toBeCloseTo(0.25 * Math.pow(10, 6 / 20), 4);
		} finally {
			await buffer.close();
		}
	});

	it("attenuates signal by 6 dB", async () => {
		const node = gain({ gain: -6 });
		const stream = node.createStream();
		const buffer = new BlockBuffer();
		const chunk = makeStereoChunk(0.5, 0.5);

		try {
			await stream._buffer(chunk, buffer);
			const output = stream._unbuffer(chunk);

			expect(output.samples[0]![0]).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 4);
		} finally {
			await buffer.close();
		}
	});

	it("processes all channels equally", async () => {
		const node = gain({ gain: 6 });
		const stream = node.createStream();
		const buffer = new BlockBuffer();
		const chunk = makeStereoChunk(0.1, 0.2);

		try {
			await stream._buffer(chunk, buffer);
			const output = stream._unbuffer(chunk);
			const factor = Math.pow(10, 6 / 20);

			expect(output.samples[0]![0]).toBeCloseTo(0.1 * factor, 4);
			expect(output.samples[1]![0]).toBeCloseTo(0.2 * factor, 4);
		} finally {
			await buffer.close();
		}
	});
});
