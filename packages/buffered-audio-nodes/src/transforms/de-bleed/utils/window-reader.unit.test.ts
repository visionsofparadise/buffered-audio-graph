/* eslint-disable @typescript-eslint/no-non-null-assertion -- typed-array indexing in test scaffolding */
import { describe, it, expect } from "vitest";
import { BlockBuffer } from "@buffered-audio/core";
import { WindowReader } from "./window-reader";

// Populates a BlockBuffer with the given per-channel integer ramps and resets it so reads start at frame 0.
async function makeBuffer(channels: Array<Array<number>>): Promise<BlockBuffer> {
	const buffer = new BlockBuffer();
	const samples = channels.map((values) => Float32Array.from(values));

	await buffer.write(samples, 44100, 32);
	await buffer.reset();

	return buffer;
}

describe("WindowReader", () => {
	// Happy path: preload fills the window from the buffer head when there is no edge pad.
	it("preload with edgePad=0 fills the window from the buffer start", async () => {
		const buffer = await makeBuffer([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]);
		const reader = new WindowReader(1, 8);

		await reader.preload(buffer, 0);

		expect(Array.from(reader.getScratch()[0]!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

		await buffer.close();
	});

	// Edge pad prepends that many zero samples at the head, per the virtual zero-pad model.
	it("preload with edgePad>0 zero-pads the head and reads the remainder", async () => {
		const buffer = await makeBuffer([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]);
		const reader = new WindowReader(1, 8);

		await reader.preload(buffer, 3);

		expect(Array.from(reader.getScratch()[0]!)).toEqual([0, 0, 0, 1, 2, 3, 4, 5]);

		await buffer.close();
	});

	// advance slides the window by `step`, keeps the tail, and appends the next `step` samples.
	it("advance slides the window and appends new samples", async () => {
		const buffer = await makeBuffer([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]);
		const reader = new WindowReader(1, 8);

		await reader.preload(buffer, 0);
		await reader.advance(buffer, 3);

		expect(Array.from(reader.getScratch()[0]!)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);

		await buffer.close();
	});

	// Boundary: advancing past the buffer end fills the shortfall with zeros and marks the buffer drained.
	it("advance past the buffer end zero-fills the shortfall", async () => {
		const buffer = await makeBuffer([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]);
		const reader = new WindowReader(1, 8);

		await reader.preload(buffer, 0);
		await reader.advance(buffer, 3); // window [4..11], cursor at 11
		await reader.advance(buffer, 3); // reads only frame 12, then drains

		expect(Array.from(reader.getScratch()[0]!)).toEqual([7, 8, 9, 10, 11, 12, 0, 0]);

		// Once drained, further advances append only zeros.
		await reader.advance(buffer, 2);
		expect(Array.from(reader.getScratch()[0]!)).toEqual([9, 10, 11, 12, 0, 0, 0, 0]);

		await buffer.close();
	});

	// step <= 0 is a no-op; the window is unchanged.
	it("advance with step<=0 leaves the window unchanged", async () => {
		const buffer = await makeBuffer([[1, 2, 3, 4, 5, 6, 7, 8]]);
		const reader = new WindowReader(1, 8);

		await reader.preload(buffer, 0);
		await reader.advance(buffer, 0);

		expect(Array.from(reader.getScratch()[0]!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

		await buffer.close();
	});

	// Multi-channel: each channel tracks its own samples independently.
	it("tracks channels independently", async () => {
		const buffer = await makeBuffer([
			[1, 2, 3, 4, 5, 6],
			[10, 20, 30, 40, 50, 60],
		]);
		const reader = new WindowReader(2, 4);

		await reader.preload(buffer, 0);

		expect(Array.from(reader.getScratch()[0]!)).toEqual([1, 2, 3, 4]);
		expect(Array.from(reader.getScratch()[1]!)).toEqual([10, 20, 30, 40]);

		await reader.advance(buffer, 2);

		expect(Array.from(reader.getScratch()[0]!)).toEqual([3, 4, 5, 6]);
		expect(Array.from(reader.getScratch()[1]!)).toEqual([30, 40, 50, 60]);

		await buffer.close();
	});
});
