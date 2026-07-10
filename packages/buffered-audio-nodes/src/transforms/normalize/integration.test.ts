import { describe, expect, it } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, runTransformStream } from "@buffered-audio/core/testing";
import { normalize } from ".";

const SAMPLE_RATE = 44100;

function makeBlock(values: Array<number>, offset = 0): Block {
	return { samples: [Float32Array.from(values)], offset, sampleRate: SAMPLE_RATE, bitDepth: 32 };
}

describe("normalize", () => {
	it("scales the signal so its peak reaches the ceiling", async () => {
		const { blocks } = await runTransformStream(normalize({ ceiling: 0.9 }), [makeBlock([0.1, -0.5, 0.25, 0.5])]);
		const out = channelSamples(blocks, 0);
		const scale = 0.9 / 0.5;

		expect(out.length).toBe(4);
		expect(out[0]).toBeCloseTo(0.1 * scale, 6);
		expect(out[1]).toBeCloseTo(-0.5 * scale, 6);
		expect(out[3]).toBeCloseTo(0.9, 6);
	});

	it("passes all-silent input through unchanged (scale = 1)", async () => {
		const { blocks } = await runTransformStream(normalize({ ceiling: 0.9 }), [makeBlock([0, 0, 0])]);
		const out = channelSamples(blocks, 0);

		expect(out.length).toBe(3);
		for (const sample of out) expect(sample).toBe(0);
	});

	it("produces identical output regardless of input chunking", async () => {
		const values = Array.from({ length: 600 }, (_, i) => Math.sin(i / 7) * 0.4);
		const single = channelSamples((await runTransformStream(normalize({ ceiling: 1 }), [makeBlock(values)])).blocks, 0);
		const chunked = channelSamples(
			(
				await runTransformStream(normalize({ ceiling: 1 }), [
					makeBlock(values.slice(0, 200), 0),
					makeBlock(values.slice(200, 450), 200),
					makeBlock(values.slice(450), 450),
				])
			).blocks,
			0,
		);

		expect(chunked.length).toBe(single.length);
		for (let i = 0; i < single.length; i++) expect(chunked[i]).toBeCloseTo(single[i]!, 6);
	});
});
