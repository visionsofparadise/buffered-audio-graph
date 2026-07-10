import { describe, it, expect } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, createTestStreamContext, runTransformStream } from "@buffered-audio/core/testing";
import { pan, PanNode, PanStream } from ".";

function makeMonoChunk(value: number, frames = 256): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset: 0, sampleRate: 48000, bitDepth: 32 };
}

function makeStereoChunk(leftValue: number, rightValue: number, frames = 256): Block {
	return { samples: [new Float32Array(frames).fill(leftValue), new Float32Array(frames).fill(rightValue)], offset: 0, sampleRate: 48000, bitDepth: 32 };
}

function applyPan(node: PanNode, chunk: Block): Block {
	const stream = new PanStream(node, createTestStreamContext().context);
	let result: Block | undefined;

	for (const block of stream._transform(chunk)) result = block;

	if (!result) throw new Error("transform yielded nothing");

	return result;
}

describe("PanNode", () => {
	it("has correct static metadata", () => {
		expect(PanNode.nodeName).toBe("Pan");
	});

	it("schema defaults to 0 (center)", () => {
		const node = pan();
		expect(node.properties.pan).toBe(0);
	});

	describe("mono -> stereo panning", () => {
		it("produces 2 output channels from 1 input channel", () => {
			const output = applyPan(pan({ pan: 0 }), makeMonoChunk(1.0));
			expect(output.samples.length).toBe(2);
		});

		it("at center (pan=0) both channels have equal power (equal-power law)", () => {
			const output = applyPan(pan({ pan: 0 }), makeMonoChunk(1.0));
			const leftRms = output.samples[0]![0]!;
			const rightRms = output.samples[1]![0]!;
			expect(leftRms).toBeCloseTo(rightRms, 5);
			expect(leftRms).toBeCloseTo(Math.SQRT2 / 2, 4);
		});

		it("at full left (pan=-1) all energy goes to left channel", () => {
			const output = applyPan(pan({ pan: -1 }), makeMonoChunk(1.0));
			expect(output.samples[0]![0]).toBeCloseTo(1.0, 5);
			expect(output.samples[1]![0]).toBeCloseTo(0.0, 5);
		});

		it("at full right (pan=1) all energy goes to right channel", () => {
			const output = applyPan(pan({ pan: 1 }), makeMonoChunk(1.0));
			expect(output.samples[0]![0]).toBeCloseTo(0.0, 5);
			expect(output.samples[1]![0]).toBeCloseTo(1.0, 5);
		});

		it("preserves constant power: L^2 + R^2 = input^2", () => {
			for (const panValue of [-0.5, 0, 0.5]) {
				const output = applyPan(pan({ pan: panValue }), makeMonoChunk(1.0));
				const leftSq = (output.samples[0]![0] ?? 0) ** 2;
				const rightSq = (output.samples[1]![0] ?? 0) ** 2;
				expect(leftSq + rightSq).toBeCloseTo(1.0, 5);
			}
		});
	});

	describe("stereo balance", () => {
		it("at center (pan=0) both channels have unity gain", () => {
			const output = applyPan(pan({ pan: 0 }), makeStereoChunk(1.0, 1.0));
			expect(output.samples.length).toBe(2);
			expect(output.samples[0]![0]).toBeCloseTo(1.0, 4);
			expect(output.samples[1]![0]).toBeCloseTo(1.0, 4);
		});

		it("at full left (pan=-1) left channel at unity, right channel silenced", () => {
			const output = applyPan(pan({ pan: -1 }), makeStereoChunk(0.8, 0.8));
			expect(output.samples[0]![0]).toBeCloseTo(0.8, 4);
			expect(output.samples[1]![0]).toBeCloseTo(0.0, 4);
		});

		it("at full right (pan=1) right channel at unity, left channel silenced", () => {
			const output = applyPan(pan({ pan: 1 }), makeStereoChunk(0.8, 0.8));
			expect(output.samples[0]![0]).toBeCloseTo(0.0, 4);
			expect(output.samples[1]![0]).toBeCloseTo(0.8, 4);
		});

		it("at partial right (pan=0.5) reduces left by half, right stays at unity", () => {
			const output = applyPan(pan({ pan: 0.5 }), makeStereoChunk(1.0, 1.0));
			expect(output.samples[0]![0]).toBeCloseTo(0.5, 4);
			expect(output.samples[1]![0]).toBeCloseTo(1.0, 4);
		});
	});

	describe("channel count validation", () => {
		it("throws when input has more than 2 channels", () => {
			const stream = new PanStream(pan({ pan: 0 }), createTestStreamContext().context);
			const chunk: Block = {
				samples: [new Float32Array(256), new Float32Array(256), new Float32Array(256)],
				offset: 0,
				sampleRate: 48000,
				bitDepth: 32,
			};

			expect(() => Array.from(stream._transform(chunk))).toThrow(/PanNode supports 1 or 2 channel inputs only/);
		});
	});

	it("pans a mono stream to stereo through the harness", async () => {
		const { blocks } = await runTransformStream(pan({ pan: -1 }), [makeMonoChunk(1.0, 256)]);

		expect(blocks[0]!.samples.length).toBe(2);
		expect(channelSamples(blocks, 0)[0]).toBeCloseTo(1.0, 5);
		expect(channelSamples(blocks, 1)[0]).toBeCloseTo(0.0, 5);
	});
});
