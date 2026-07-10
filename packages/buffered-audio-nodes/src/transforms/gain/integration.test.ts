import { describe, it, expect } from "vitest";
import type { Block } from "@buffered-audio/core";
import { createTestStreamContext } from "@buffered-audio/core/testing";
import { gain, GainNode, GainStream } from ".";

function makeStereoChunk(leftValue: number, rightValue: number, frames = 512): Block {
	const left = new Float32Array(frames).fill(leftValue);
	const right = new Float32Array(frames).fill(rightValue);
	return { samples: [left, right], offset: 0, sampleRate: 48000, bitDepth: 32 };
}

function applyGain(node: GainNode, chunk: Block): Block {
	const stream = new GainStream(node, createTestStreamContext().context);
	let result: Block | undefined;

	for (const block of stream._transform(chunk)) result = block;

	if (!result) throw new Error("transform yielded nothing");

	return result;
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

	it("passes signal unchanged at 0 dB", () => {
		const output = applyGain(gain({ gain: 0 }), makeStereoChunk(0.5, -0.5));

		for (let i = 0; i < 512; i++) {
			expect(output.samples[0]![i]).toBeCloseTo(0.5, 5);
			expect(output.samples[1]![i]).toBeCloseTo(-0.5, 5);
		}
	});

	it("amplifies signal by 6 dB (~factor 2)", () => {
		const output = applyGain(gain({ gain: 6 }), makeStereoChunk(0.25, 0.25));

		expect(output.samples[0]![0]).toBeCloseTo(0.25 * Math.pow(10, 6 / 20), 4);
	});

	it("attenuates signal by 6 dB", () => {
		const output = applyGain(gain({ gain: -6 }), makeStereoChunk(0.5, 0.5));

		expect(output.samples[0]![0]).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 4);
	});

	it("processes all channels equally", () => {
		const output = applyGain(gain({ gain: 6 }), makeStereoChunk(0.1, 0.2));
		const factor = Math.pow(10, 6 / 20);

		expect(output.samples[0]![0]).toBeCloseTo(0.1 * factor, 4);
		expect(output.samples[1]![0]).toBeCloseTo(0.2 * factor, 4);
	});
});
