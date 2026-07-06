import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlockBuffer, ReverseBlockReader } from "./block-buffer";
import type { Block } from "./node";

// Builds a per-channel ramp with DISTINCT per-channel values so a mistaken channel swap or a
// deinterleave error is caught: channel `ch` holds ch * 1000 + frame at each frame.
function makeRamp(frames: number, channels: number): Array<Float32Array> {
	const out: Array<Float32Array> = [];

	for (let ch = 0; ch < channels; ch++) {
		const data = new Float32Array(frames);

		for (let frame = 0; frame < frames; frame++) data[frame] = ch * 1000 + frame;
		out.push(data);
	}

	return out;
}

// Writes a ramp as an interleaved float32 temp file (frame * channels + ch layout, matching the
// on-disk forward layout) so a ReverseBlockReader can be constructed directly, independent of any
// BlockBuffer internals. Returns the path; caller unlinks.
async function writeInterleavedRamp(frames: number, channels: number): Promise<string> {
	const interleaved = new Float32Array(frames * channels);

	for (let frame = 0; frame < frames; frame++) {
		for (let ch = 0; ch < channels; ch++) {
			interleaved[frame * channels + ch] = ch * 1000 + frame;
		}
	}

	const path = join(tmpdir(), `reverse-reader-test-${randomUUID()}.bin`);

	await writeFile(path, Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength));

	return path;
}

// Concatenates every channel of every returned chunk into one array per channel, in call order.
function concatChunks(chunks: Array<Array<Float32Array>>, channels: number): Array<Array<number>> {
	const out: Array<Array<number>> = [];

	for (let ch = 0; ch < channels; ch++) out.push([]);

	for (const samples of chunks) {
		for (let ch = 0; ch < channels; ch++) {
			for (const value of samples[ch] ?? []) out[ch]!.push(value);
		}
	}

	return out;
}

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

		for (let ch = 0; ch < channels; ch++) {
			const forwardValues = Array.from(forward.samples[ch]!);
			const reverseValues = Array.from(reverse.samples[ch]!);

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
		// 250 / 60 => 4 full chunks of 60 then a ragged 10.
		expect(collected.map((samples) => samples[0]!.length)).toEqual([60, 60, 60, 60, 10]);

		// Next read after drain is empty.
		const tail = await reader.read(readSize);

		expect(tail.samples[0]?.length ?? 0).toBe(0);

		await reader.close();
		await buffer.close();
	});

	it("crosses stripe boundaries with reads misaligned to the stripe (spanning case)", async () => {
		const frames = 4096;
		const channels = 2;
		// Direct construction over a hand-written interleaved file so a tiny stripe can be injected,
		// independent of any BlockBuffer internals.
		const path = await writeInterleavedRamp(frames, channels);

		// Stripe of 300 bytes holds under 38 frames (300 / 8), far smaller than the 4096-frame buffer;
		// read 100 frames at a time — misaligned to the stripe, so single reads span several stripes.
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

			for (let ch = 0; ch < channels; ch++) {
				expect(reversed[ch]).toEqual([...Array.from(expected[ch]!)].reverse());
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

		// No manual flushWrites — the factory must flush.
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

		// Reader still open — clear() must close it before unlink, no EBUSY.
		await expect(buffer.clear()).resolves.toBeUndefined();

		// Reader is now closed.
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

		// A reads 50, B reads 200 — cursors are independent.
		const a1 = await readerA.read(50);
		const b1 = await readerB.read(200);

		expect(a1.offset).toBe(0);
		expect(b1.offset).toBe(0);
		expect(a1.samples[0]!.length).toBe(50);
		expect(b1.samples[0]!.length).toBe(200);
		// Both start from the last source frame (299) walking backward.
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

		// Start a forward read session, consume part of it.
		const fwd1 = await buffer.read(100);

		expect(Array.from(fwd1.samples[0]!.subarray(0, 3))).toEqual([0, 1, 2]);

		// Drain a reverse reader completely in the middle of the forward session.
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

		// Forward session continues undisturbed from frame 100.
		const fwd2 = await buffer.read(100);

		expect(fwd2.samples[0]![0]).toBe(100);
		expect(fwd2.samples[0]![99]).toBe(199);

		await buffer.close();
	});

	it("close() mid-drain settles the in-flight read without hanging or an unhandled rejection", async () => {
		const frames = 200_000;
		const channels = 2;
		const buffer = new BlockBuffer();

		await buffer.write(makeRamp(frames, channels), 44100, 32);
		await buffer.flushWrites();

		const reader = await buffer.openReverseReader();

		// Start a large read, then close the reader before it settles. The in-flight read must settle
		// (not hang) once close() destroys the underlying stream: pullBytes wakes on 'close', returns
		// short, and read() throws. No unhandled rejection is possible because we await the promise.
		const pending = reader.read(frames);
		const settled = pending.then(
			() => "resolved" as const,
			(error: unknown) => (error as Error).message,
		);

		await reader.close();

		const outcome = await settled;

		// The in-flight read rejects (either the throw-after-close guard or the short-return throw,
		// depending on ordering) — never resolves, never hangs.
		expect(outcome).not.toBe("resolved");
		expect(outcome).toMatch(/read\(\) after close\(\)|end of reverse stream/);

		await buffer.close();
	});

	it("a truncated source file makes the in-flight read reject rather than hang", async () => {
		const channels = 2;
		// Write only 100 frames but tell the reader there are 4096 — the reverse stream will hit EOF
		// mid-window, destroy(err), and the in-flight read must reject rather than hang.
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

		// 250 / 60 => 60, 60, 60, 60, 10 (trailing short).
		expect(lengths).toEqual([60, 60, 60, 60, 10]);
		// Reverse-time order: source frame 249 down to 0.
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
