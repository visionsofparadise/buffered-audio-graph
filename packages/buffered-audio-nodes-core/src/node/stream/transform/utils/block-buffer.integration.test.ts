import { describe, expect, it } from "vitest";
import type { Block } from "../../block";
import { BlockBuffer } from "./block-buffer";

describe("BlockBuffer", () => {
	it("write + read round-trips data sequentially after a flush", async () => {
		const buffer = new BlockBuffer();

		await buffer.write([new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])], 44100, 32);
		await buffer.flushWrites();

		const chunk = await buffer.read(8);

		expect(Array.from(chunk.samples[0]!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(buffer.frames).toBe(8);
		expect(buffer.sampleRate).toBe(44100);
		expect(buffer.bitDepth).toBe(32);

		const tail = await buffer.read(4);

		expect(tail.samples[0]?.length ?? 0).toBe(0);

		await buffer.close();
	});

	it("read signals end-of-buffer with a short chunk", async () => {
		const buffer = new BlockBuffer();

		await buffer.write([new Float32Array([10, 20, 30])], 44100, 32);
		await buffer.flushWrites();

		const chunk = await buffer.read(10);

		expect(chunk.samples[0]?.length).toBe(3);

		await buffer.close();
	});

	it("clear drops all data and resets state", async () => {
		const buffer = new BlockBuffer();

		await buffer.write([new Float32Array([1, 2, 3])], 44100, 32);
		await buffer.clear();

		expect(buffer.frames).toBe(0);

		await buffer.write([new Float32Array([9, 8])], 44100, 32);
		await buffer.flushWrites();

		const chunk = await buffer.read(2);

		expect(Array.from(chunk.samples[0]!)).toEqual([9, 8]);

		await buffer.close();
	});

	it("reset rewinds the reader so subsequent reads start from byte 0", async () => {
		const buffer = new BlockBuffer();

		await buffer.write([new Float32Array([1, 2, 3, 4])], 44100, 32);
		await buffer.flushWrites();

		const first = await buffer.read(2);

		expect(Array.from(first.samples[0]!)).toEqual([1, 2]);

		await buffer.reset();

		const second = await buffer.read(4);

		expect(Array.from(second.samples[0]!)).toEqual([1, 2, 3, 4]);

		await buffer.close();
	});

	it("reset rewinds the writer so subsequent writes overwrite from byte 0", async () => {
		const buffer = new BlockBuffer();

		await buffer.write([new Float32Array([1, 2, 3, 4])], 44100, 32);
		await buffer.reset();
		await buffer.write([new Float32Array([10, 20])], 44100, 32);
		await buffer.reset();

		const chunk = await buffer.read(4);

		expect(Array.from(chunk.samples[0]!)).toEqual([10, 20, 3, 4]);
		expect(buffer.frames).toBe(4);

		await buffer.close();
	});

	it("crosses the file-backing threshold transparently", async () => {
		const buffer = new BlockBuffer();
		const chunkSize = 200_000;
		const totalChunks = 80;

		for (let c = 0; c < totalChunks; c++) {
			const data = new Float32Array(chunkSize);

			for (let i = 0; i < chunkSize; i++) data[i] = c * chunkSize + i;
			await buffer.write([data], 44100, 32);
		}

		await buffer.flushWrites();

		expect(buffer.frames).toBe(chunkSize * totalChunks);

		const sample = await buffer.read(4);

		expect(Array.from(sample.samples[0]!)).toEqual([0, 1, 2, 3]);

		await buffer.close();
	});

	it("throws on channel-count mismatch after the channel count is locked", async () => {
		const buffer = new BlockBuffer();

		await buffer.write([new Float32Array([1, 2])], 44100, 32);

		await expect(buffer.write([new Float32Array([3, 4]), new Float32Array([10, 20])], 44100, 32)).rejects.toThrow(/channel count mismatch/);

		await buffer.close();
	});

	it("iterate yields every read including the trailing short block, then stops", async () => {
		const buffer = new BlockBuffer();

		// 250 frames read 100 at a time => 100, 100, 50 (trailing short), then done.
		await buffer.write([new Float32Array(Array.from({ length: 250 }, (_v, i) => i))], 44100, 32);
		await buffer.flushWrites();

		const lengths: Array<number> = [];
		let expectedOffset = 0;

		for await (const block of buffer.iterate(100)) {
			const got = block.samples[0]?.length ?? 0;

			expect(block.offset).toBe(expectedOffset);
			expectedOffset += got;
			lengths.push(got);
		}

		expect(lengths).toEqual([100, 100, 50]);

		await buffer.close();
	});

	it("iterate over an exact multiple yields only full blocks", async () => {
		const buffer = new BlockBuffer();

		await buffer.write([new Float32Array(200)], 44100, 32);
		await buffer.flushWrites();

		const lengths: Array<number> = [];

		for await (const block of buffer.iterate(50)) {
			lengths.push(block.samples[0]?.length ?? 0);
		}

		expect(lengths).toEqual([50, 50, 50, 50]);

		await buffer.close();
	});

	it("iterate over an empty buffer yields nothing", async () => {
		const buffer = new BlockBuffer();

		const blocks: Array<Block> = [];

		for await (const block of buffer.iterate(64)) {
			blocks.push(block);
		}

		expect(blocks.length).toBe(0);

		await buffer.close();
	});
});
