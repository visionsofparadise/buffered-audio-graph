import { describe, expect, it } from "vitest";
import type { Block } from "../node/stream/block";
import { sliceBlock } from "./slice-block";

function block(values: Array<Array<number>>, offset = 0): Block {
	return {
		samples: values.map((channel) => Float32Array.from(channel)),
		offset,
		sampleRate: 48000,
		bitDepth: 24,
	};
}

describe("sliceBlock", () => {
	it("returns the same block when the slice spans the whole block", () => {
		const source = block([[1, 2, 3, 4]], 100);

		expect(sliceBlock(source, 0, 4)).toBe(source);
	});

	it("slices each channel and shifts the offset", () => {
		const source = block(
			[
				[1, 2, 3, 4, 5],
				[6, 7, 8, 9, 10],
			],
			100,
		);

		const sliced = sliceBlock(source, 1, 2);

		expect(Array.from(sliced.samples[0]!)).toEqual([2, 3]);
		expect(Array.from(sliced.samples[1]!)).toEqual([7, 8]);
		expect(sliced.offset).toBe(101);
		expect(sliced.sampleRate).toBe(48000);
		expect(sliced.bitDepth).toBe(24);
	});

	it("shares memory with the source via subarray", () => {
		const source = block([[1, 2, 3, 4]], 0);
		const sliced = sliceBlock(source, 1, 2);

		source.samples[0]![1] = 99;

		expect(sliced.samples[0]![0]).toBe(99);
	});

	it("keeps the fast path from mutating a non-zero offset block", () => {
		const source = block([[1, 2, 3]], 50);

		expect(sliceBlock(source, 0, 3).offset).toBe(50);
	});
});
