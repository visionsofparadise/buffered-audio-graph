import { randomUUID } from "node:crypto";
import { open, type FileHandle, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Block } from "../../block";
import { BlockBuffer } from "./block-buffer";
import { ReverseBlockReader } from "./reverse-block-reader";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();

	return {
		...actual,
		open: vi.fn(actual.open),
	};
});

const mockOpen = vi.mocked(open);

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});

	return { promise, resolve };
}

function makeRamp(frames: number, channels: number): Array<Float32Array> {
	const out: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		const data = new Float32Array(frames);

		for (let frame = 0; frame < frames; frame++) data[frame] = channel * 1000 + frame;
		out.push(data);
	}

	return out;
}

async function writeInterleavedRamp(frames: number, channels: number): Promise<string> {
	const interleaved = new Float32Array(frames * channels);

	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			interleaved[frame * channels + channel] = channel * 1000 + frame;
		}
	}

	const path = join(tmpdir(), `reverse-reader-test-${randomUUID()}.bin`);

	await writeFile(path, Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength));

	return path;
}

function concatChunks(chunks: Array<Array<Float32Array>>, channels: number): Array<Array<number>> {
	const out: Array<Array<number>> = [];

	for (let channel = 0; channel < channels; channel++) out.push([]);

	for (const samples of chunks) {
		for (let channel = 0; channel < channels; channel++) {
			for (const value of samples[channel] ?? []) out[channel]!.push(value);
		}
	}

	return out;
}
describe("ReverseBlockReader", () => {
	it("returns the exact mirror of a full forward read (multichannel deinterleave + reversal)", async () => {
		const frames = 500;
		const channels = 3;
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(frames, channels), 44100, 32);
		await buffer.flushWrites();

		const forward = await buffer.read(frames);

		await buffer.reset();

		const reader = await buffer.openReverseReader();
		const reverse = await reader.read(frames);

		expect(reader.frames).toBe(frames);
		expect(reader.channels).toBe(channels);
		expect(reverse.sampleRate).toBe(44100);
		expect(reverse.bitDepth).toBe(32);
		expect(reverse.offset).toBe(0);

		for (let channel = 0; channel < channels; channel++) {
			const forwardValues = Array.from(forward.samples[channel]!);
			const reverseValues = Array.from(reverse.samples[channel]!);

			expect(reverseValues).toEqual([...forwardValues].reverse());
		}

		await reader.close();
		await buffer.close();
	});

	it("yields full chunks then a ragged short chunk, then empty; total frames == frames", async () => {
		const frames = 250;
		const channels = 2;
		const readSize = 60;
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(frames, channels), 44100, 32);

		const reader = await buffer.openReverseReader();
		const collected: Array<Array<Float32Array>> = [];
		let total = 0;
		let expectedOffset = 0;

		for (;;) {
			const chunk = await reader.read(readSize);
			const got = chunk.samples[0]?.length ?? 0;

			if (got === 0) break;

			expect(chunk.offset).toBe(expectedOffset);
			expectedOffset += got;
			total += got;
			collected.push(chunk.samples);
		}

		expect(total).toBe(frames);
		expect(collected.map((samples) => samples[0]!.length)).toEqual([60, 60, 60, 60, 10]);

		const tail = await reader.read(readSize);

		expect(tail.samples[0]?.length ?? 0).toBe(0);

		await reader.close();
		await buffer.close();
	});

	it("crosses stripe boundaries with reads misaligned to the stripe (spanning case)", async () => {
		const frames = 4096;
		const channels = 2;
		const path = await writeInterleavedRamp(frames, channels);

		const reader = new ReverseBlockReader(path, { frames, channels, sampleRate: 44100, bitDepth: 32 }, 300);
		const chunks: Array<Array<Float32Array>> = [];

		try {
			for (;;) {
				const chunk = await reader.read(100);

				if ((chunk.samples[0]?.length ?? 0) === 0) break;
				chunks.push(chunk.samples);
			}

			const reversed = concatChunks(chunks, channels);
			const expected = makeRamp(frames, channels);

			for (let channel = 0; channel < channels; channel++) {
				expect(reversed[channel]).toEqual([...Array.from(expected[channel]!)].reverse());
			}
		} finally {
			await reader.close();
			await unlink(path).catch(() => undefined);
		}
	});

	it("openReverseReader() auto-flushes pending writes", async () => {
		const frames = 128;
		const channels = 1;
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(frames, channels), 44100, 32);

		const reader = await buffer.openReverseReader();

		expect(reader.frames).toBe(frames);

		const chunk = await reader.read(frames);

		expect(chunk.samples[0]?.length).toBe(frames);
		expect(Array.from(chunk.samples[0]!)).toEqual([...Array.from({ length: frames }, (_v, idx) => idx)].reverse());

		await reader.close();
		await buffer.close();
	});

	it("empty / never-written buffer yields an empty chunk and closes cleanly", async () => {
		const buffer = new BlockBuffer();
		const reader = await buffer.openReverseReader();

		expect(reader.frames).toBe(0);

		const chunk = await reader.read(64);

		expect(chunk.samples.length).toBe(0);

		await expect(reader.close()).resolves.toBeUndefined();
		await buffer.close();
	});

	it("read after close throws; close is idempotent", async () => {
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(32, 1), 44100, 32);

		const reader = await buffer.openReverseReader();

		await reader.close();
		await expect(reader.close()).resolves.toBeUndefined();
		await expect(reader.read(4)).rejects.toThrow(/read\(\) after close\(\)/);

		await buffer.close();
	});

	it("parent clear() with an open reader succeeds (Windows EBUSY guard) and closes the reader", async () => {
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(64, 1), 44100, 32);

		const reader = await buffer.openReverseReader();

		// Windows cannot unlink the temp file until the borrowed reader closes its handle.
		await expect(buffer.clear()).resolves.toBeUndefined();

		await expect(reader.read(4)).rejects.toThrow(/read\(\) after close\(\)/);

		await buffer.close();
	});

	it("parent close() with an open reader succeeds and closes the reader", async () => {
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(64, 1), 44100, 32);

		const reader = await buffer.openReverseReader();

		await expect(buffer.close()).resolves.toBeUndefined();
		await expect(reader.read(4)).rejects.toThrow(/read\(\) after close\(\)/);
	});

	it("two concurrent readers advance independently", async () => {
		const frames = 300;
		const channels = 1;
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(frames, channels), 44100, 32);

		const readerA = await buffer.openReverseReader();
		const readerB = await buffer.openReverseReader();

		const a1 = await readerA.read(50);
		const b1 = await readerB.read(200);

		expect(a1.offset).toBe(0);
		expect(b1.offset).toBe(0);
		expect(a1.samples[0]!.length).toBe(50);
		expect(b1.samples[0]!.length).toBe(200);
		expect(a1.samples[0]![0]).toBe(frames - 1);
		expect(b1.samples[0]![0]).toBe(frames - 1);

		const a2 = await readerA.read(50);

		expect(a2.offset).toBe(50);
		expect(a2.samples[0]![0]).toBe(frames - 1 - 50);

		const b2 = await readerB.read(200);

		expect(b2.offset).toBe(200);
		expect(b2.samples[0]!.length).toBe(frames - 200);

		await readerA.close();
		await readerB.close();
		await buffer.close();
	});

	it("a reverse reader draining a buffer does not disturb an in-progress forward read session", async () => {
		const frames = 400;
		const channels = 1;
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(frames, channels), 44100, 32);
		await buffer.flushWrites();

		const fwd1 = await buffer.read(100);

		expect(Array.from(fwd1.samples[0]!.subarray(0, 3))).toEqual([0, 1, 2]);

		const reader = await buffer.openReverseReader();
		let reverseTotal = 0;

		for (;;) {
			const chunk = await reader.read(64);
			const got = chunk.samples[0]?.length ?? 0;

			if (got === 0) break;
			reverseTotal += got;
		}

		expect(reverseTotal).toBe(frames);
		await reader.close();

		const fwd2 = await buffer.read(100);

		expect(fwd2.samples[0]![0]).toBe(100);
		expect(fwd2.samples[0]![99]).toBe(199);

		await buffer.close();
	});

	it("closes a file handle acquired after close begins", async () => {
		const path = await writeInterleavedRamp(64, 1);
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		const openStarted = deferred();
		const releaseOpen = deferred();
		let openedHandle: FileHandle | undefined;
		let closeCalls = 0;

		mockOpen.mockImplementationOnce(async () => {
			openStarted.resolve();
			await releaseOpen.promise;

			const handle = await actual.open(path, "r");
			const close = handle.close.bind(handle);

			vi.spyOn(handle, "close").mockImplementation(async () => {
				closeCalls++;
				await close();
			});
			openedHandle = handle;

			return handle;
		});

		const reader = new ReverseBlockReader(path, { frames: 64, channels: 1, sampleRate: 44100, bitDepth: 32 });
		const pendingRead = reader.read(1);

		await openStarted.promise;

		const pendingClose = reader.close();

		releaseOpen.resolve();
		await Promise.allSettled([pendingRead, pendingClose]);

		try {
			expect(closeCalls).toBe(1);
		} finally {
			if (openedHandle && closeCalls === 0) await openedHandle.close().catch(() => undefined);
			await unlink(path).catch(() => undefined);
		}
	});

	it("close() mid-drain settles the in-flight read without hanging or an unhandled rejection", async () => {
		const frames = 200_000;
		const channels = 2;
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(frames, channels), 44100, 32);
		await buffer.flushWrites();

		const reader = await buffer.openReverseReader();

		// Destroying the stream must wake pullBytes through its close listener.
		const pending = reader.read(frames);
		const settled = pending.then(
			() => "resolved" as const,
			(error: unknown) => (error as Error).message,
		);

		await reader.close();

		const outcome = await settled;

		expect(outcome).not.toBe("resolved");
		expect(outcome).toMatch(/read\(\) after close\(\)|end of reverse stream/);

		await buffer.close();
	});

	it("a truncated source file makes the in-flight read reject rather than hang", async () => {
		const channels = 2;
		const realFrames = 100;
		const claimedFrames = 4096;
		const path = await writeInterleavedRamp(realFrames, channels);
		const reader = new ReverseBlockReader(path, { frames: claimedFrames, channels, sampleRate: 44100, bitDepth: 32 });

		try {
			await expect(reader.read(claimedFrames)).rejects.toThrow(/EOF|end of reverse stream/);
		} finally {
			await reader.close();
			await unlink(path).catch(() => undefined);
		}
	});

	it("iterate yields the reversed stream in blocks including a trailing short block", async () => {
		const frames = 250;
		const channels = 1;
		const readSize = 60;
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(frames, channels), 44100, 32);

		const reader = await buffer.openReverseReader();
		const lengths: Array<number> = [];
		const collected: Array<number> = [];
		let expectedOffset = 0;

		for await (const block of reader.iterate(readSize)) {
			const got = block.samples[0]?.length ?? 0;

			expect(block.offset).toBe(expectedOffset);
			expectedOffset += got;
			lengths.push(got);

			for (const value of block.samples[0] ?? []) collected.push(value);
		}

		expect(lengths).toEqual([60, 60, 60, 60, 10]);
		expect(collected).toEqual(Array.from({ length: frames }, (_v, i) => frames - 1 - i));

		await reader.close();
		await buffer.close();
	});

	it("iterate over an empty reverse reader yields nothing", async () => {
		const buffer = new BlockBuffer();
		const reader = await buffer.openReverseReader();

		const blocks: Array<Block> = [];

		for await (const block of reader.iterate(64)) {
			blocks.push(block);
		}

		expect(blocks.length).toBe(0);

		await reader.close();
		await buffer.close();
	});
});
