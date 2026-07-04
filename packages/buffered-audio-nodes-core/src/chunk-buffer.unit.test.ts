import { describe, expect, it } from "vitest";
import { ChunkBuffer } from "./chunk-buffer";

describe("ChunkBuffer", () => {
	it("write + read round-trips data sequentially after a flush", async () => {
		const buffer = new ChunkBuffer();

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
		const buffer = new ChunkBuffer();

		await buffer.write([new Float32Array([10, 20, 30])], 44100, 32);
		await buffer.flushWrites();

		const chunk = await buffer.read(10);

		expect(chunk.samples[0]?.length).toBe(3);

		await buffer.close();
	});

	it("clear drops all data and resets state", async () => {
		const buffer = new ChunkBuffer();

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
		const buffer = new ChunkBuffer();

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
		const buffer = new ChunkBuffer();

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
		const buffer = new ChunkBuffer();
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
		const buffer = new ChunkBuffer();

		await buffer.write([new Float32Array([1, 2])], 44100, 32);

		await expect(buffer.write([new Float32Array([3, 4]), new Float32Array([10, 20])], 44100, 32)).rejects.toThrow(/channel count mismatch/);

		await buffer.close();
	});
});
