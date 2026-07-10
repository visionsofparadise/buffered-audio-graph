import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import type { Block, RenderEvents, StreamContext } from "@buffered-audio/core";
import { dither, DitherStream } from ".";

function renderContext(): StreamContext {
	return { events: new EventEmitter() as RenderEvents, nextStreamId: () => 0 };
}

function applyDither(bitDepth: 16 | 24, input: Float32Array): Block {
	const node = dither(bitDepth);
	const stream = new DitherStream(node, renderContext());
	let result: Block | undefined;

	for (const block of stream._transform({ samples: [input], offset: 0, sampleRate: 44100, bitDepth: 32 })) result = block;

	if (!result) throw new Error("transform yielded nothing");

	return result;
}

describe("DitherStream", () => {
	it("quantizes samples to 16-bit grid", () => {
		const levels = Math.pow(2, 15);
		const result = applyDither(16, new Float32Array([0.12345678, -0.98765432, 0, 0.5]));

		for (const sample of result.samples[0]!) {
			const scaled = Math.round(sample * levels);
			const snapped = scaled / levels;
			expect(Math.abs(sample - snapped)).toBeLessThan(1e-10);
		}
	});

	it("quantizes samples to 24-bit grid", () => {
		const levels = Math.pow(2, 23);
		const result = applyDither(24, new Float32Array([0.12345678, -0.98765432]));

		for (const sample of result.samples[0]!) {
			const scaled = Math.round(sample * levels);
			const snapped = scaled / levels;
			expect(Math.abs(sample - snapped)).toBeLessThan(1e-10);
		}
	});

	it("preserves silence", () => {
		const result = applyDither(16, new Float32Array(100).fill(0));

		for (const sample of result.samples[0]!) {
			expect(Math.abs(sample)).toBeLessThan(0.001);
		}
	});
});
