import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Block } from "../../block";
import { BlockBuffer } from "./block-buffer";

vi.mock("node:fs", { spy: true });

describe("BlockBuffer", () => {
	it("uses its injected directory and unlinks block-buffer files on clear and close", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "block-buffer-test-"));
		const buffer = new BlockBuffer(temporaryDirectory);

		try {
			await buffer.write([new Float32Array([1, 2, 3])], 44100, 32);
			await buffer.flushWrites();

			expect(await readdir(temporaryDirectory)).toEqual([expect.stringMatching(/^block-buffer-[\da-f-]+\.bin$/)]);

			await buffer.clear();

			expect(await readdir(temporaryDirectory)).toEqual([]);

			await buffer.write([new Float32Array([4, 5, 6])], 44100, 32);
			await buffer.flushWrites();

			expect(await readdir(temporaryDirectory)).toEqual([expect.stringMatching(/^block-buffer-[\da-f-]+\.bin$/)]);

			await buffer.close();

			expect(await readdir(temporaryDirectory)).toEqual([]);
		} finally {
			await buffer.close();
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

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

		await expect(buffer.write([new Float32Array([3, 4]), new Float32Array([10, 20])], 44100, 32)).rejects.toThrow(
			/channel count mismatch/,
		);

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

	it("rejects a write that waits for drain when its file stream fails", async () => {
		const diskFull = new Error("ENOSPC: no space left on device, write");
		const failing = new Writable({
			highWaterMark: 16,
			write(_chunk, _encoding, callback) {
				setTimeout(() => callback(diskFull), 10);
			},
		});

		vi.mocked(createWriteStream).mockReturnValueOnce(failing as WriteStream);

		const buffer = new BlockBuffer();
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			const write = buffer.write([new Float32Array(1024)], 44100, 32);
			const hung = new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("write did not settle within 2000ms")), 2_000);
			});

			await expect(Promise.race([write, hung])).rejects.toBe(diskFull);
		} finally {
			clearTimeout(timeout);
			await buffer.close().catch(() => undefined);
		}
	});

	describe("after its file stream fails", () => {
		const diskFull = new Error("ENOSPC: no space left on device, write");

		// Stands in for the buffer's next file stream: it creates the temp file, as a real one would, and fails every
		// write with ENOSPC on a later turn. A 16-byte high-water mark makes a write wait for drain.
		function failNextFileStream(highWaterMark?: number): Writable {
			const failing = new Writable({
				highWaterMark,
				write(_chunk, _encoding, callback) {
					setTimeout(() => callback(diskFull), 10);
				},
			});

			vi.mocked(createWriteStream).mockImplementationOnce((path) => {
				writeFileSync(path, "");

				return failing as WriteStream;
			});

			return failing;
		}

		function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const hung = new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`did not settle within ${String(milliseconds)}ms`)),
					milliseconds,
				);
			});

			return Promise.race([promise, hung]).finally(() => clearTimeout(timeout));
		}

		it("rejects the next write within 100 ms when the stream failed between writes, and close removes the temp file", async () => {
			const temporaryDirectory = await mkdtemp(join(tmpdir(), "block-buffer-failed-"));
			const failing = failNextFileStream();
			const buffer = new BlockBuffer(temporaryDirectory);

			try {
				await buffer.write([new Float32Array(1024)], 44100, 32);
				await new Promise((resolve) => failing.once("close", resolve));

				expect(failing.errored).toBe(diskFull);
				await expect(settleWithin(buffer.write([new Float32Array(1024)], 44100, 32), 100)).rejects.toBe(diskFull);
				await expect(settleWithin(buffer.close(), 1000)).resolves.toBeUndefined();
				expect(await readdir(temporaryDirectory)).toEqual([]);
			} finally {
				await rm(temporaryDirectory, { recursive: true, force: true });
			}
		});

		it("resolves close and removes the temp file after a write waiting for drain was rejected", async () => {
			const temporaryDirectory = await mkdtemp(join(tmpdir(), "block-buffer-failed-"));
			const buffer = new BlockBuffer(temporaryDirectory);

			failNextFileStream(16);

			try {
				await expect(settleWithin(buffer.write([new Float32Array(1024)], 44100, 32), 2000)).rejects.toBe(diskFull);
				await expect(settleWithin(buffer.close(), 1000)).resolves.toBeUndefined();
				expect(await readdir(temporaryDirectory)).toEqual([]);
			} finally {
				await rm(temporaryDirectory, { recursive: true, force: true });
			}
		});

		it("resolves reset and removes the temp file after a write waiting for drain was rejected", async () => {
			const temporaryDirectory = await mkdtemp(join(tmpdir(), "block-buffer-failed-"));
			const buffer = new BlockBuffer(temporaryDirectory);

			failNextFileStream(16);

			try {
				await expect(settleWithin(buffer.write([new Float32Array(1024)], 44100, 32), 2000)).rejects.toBe(diskFull);
				await expect(settleWithin(buffer.reset(), 1000)).resolves.toBeUndefined();
				expect(await readdir(temporaryDirectory)).toEqual([]);
			} finally {
				await buffer.close().catch(() => undefined);
				await rm(temporaryDirectory, { recursive: true, force: true });
			}
		});

		it("empties the buffer on reset when flushWrites ran after a rejected write", async () => {
			const temporaryDirectory = await mkdtemp(join(tmpdir(), "block-buffer-failed-"));
			const buffer = new BlockBuffer(temporaryDirectory);

			failNextFileStream(16);

			try {
				await expect(settleWithin(buffer.write([new Float32Array(1024)], 44100, 32), 2000)).rejects.toBe(diskFull);
				await buffer.flushWrites();
				await buffer.reset();

				expect(buffer.frames).toBe(0);
				expect(await readdir(temporaryDirectory)).toEqual([]);
			} finally {
				await buffer.close().catch(() => undefined);
				await rm(temporaryDirectory, { recursive: true, force: true });
			}
		});

		it("rejects a write after flushWrites with the recorded failure, opening no new file stream", async () => {
			const temporaryDirectory = await mkdtemp(join(tmpdir(), "block-buffer-failed-"));
			const buffer = new BlockBuffer(temporaryDirectory);

			failNextFileStream(16);

			try {
				await expect(settleWithin(buffer.write([new Float32Array(1024)], 44100, 32), 2000)).rejects.toBe(diskFull);
				await buffer.flushWrites();

				const streamsBefore = vi.mocked(createWriteStream).mock.calls.length;

				await expect(settleWithin(buffer.write([new Float32Array(1024)], 44100, 32), 100)).rejects.toBe(diskFull);
				expect(vi.mocked(createWriteStream).mock.calls.length).toBe(streamsBefore);
			} finally {
				await buffer.close().catch(() => undefined);
				await rm(temporaryDirectory, { recursive: true, force: true });
			}
		});

		it("rejects a write waiting for drain when its file stream closes without an error", async () => {
			const temporaryDirectory = await mkdtemp(join(tmpdir(), "block-buffer-closed-"));
			// A file stream that never finishes a write, so the first write waits for drain until the stream closes.
			const stalled = new Writable({ highWaterMark: 16, write() {} });

			vi.mocked(createWriteStream).mockReturnValueOnce(stalled as WriteStream);

			const buffer = new BlockBuffer(temporaryDirectory);

			try {
				const write = settleWithin(buffer.write([new Float32Array(1024)], 44100, 32), 1000);

				setTimeout(() => stalled.destroy(), 20);

				await expect(write).rejects.toThrow("BlockBuffer: its file stream was closed before the write");
			} finally {
				await settleWithin(buffer.close(), 1000).catch(() => undefined);
				await rm(temporaryDirectory, { recursive: true, force: true });
			}
		});
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
