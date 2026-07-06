import { describe, it, expect } from "vitest";
import type { Block, StreamContext } from "@buffered-audio/core";
import { pad, PadStream } from ".";

const SAMPLE_RATE = 44100;

function context(): StreamContext {
	return { executionProviders: ["cpu"], memoryLimit: 256 * 1024 * 1024, highWaterMark: 16, visited: new Set() };
}

function readableFrom(chunks: Array<Block>): ReadableStream<Block> {
	let index = 0;

	return new ReadableStream<Block>({
		pull: (controller) => {
			const chunk = chunks[index];

			if (chunk) {
				index += 1;
				controller.enqueue(chunk);
			} else {
				controller.close();
			}
		},
	});
}

async function drain(readable: ReadableStream<Block>): Promise<Array<Block>> {
	const out: Array<Block> = [];
	const reader = readable.getReader();

	for (;;) {
		const { done, value } = await reader.read();

		if (done) break;
		if (value) out.push(value);
	}

	return out;
}

function concatChannel(chunks: Array<Block>, channel: number): Float32Array {
	const total = chunks.reduce((sum, c) => sum + (c.samples[channel]?.length ?? 0), 0);
	const out = new Float32Array(total);
	let offset = 0;

	for (const c of chunks) {
		const src = c.samples[channel];

		if (src) {
			out.set(src, offset);
			offset += src.length;
		}
	}

	return out;
}

async function runPad(properties: Parameters<typeof pad>[0], input: Array<Block>, channel = 0): Promise<Float32Array> {
	const node = pad(properties);
	const stream = node.createStream() as PadStream;
	const output = await stream._setup(readableFrom(input), context());

	return concatChannel(await drain(output), channel);
}

function makeRamp(frames: number, offset = 0, step = 0.0001): Block {
	const channel = new Float32Array(frames);

	for (let i = 0; i < frames; i++) channel[i] = 0.1 + i * step;

	return { samples: [channel], offset, sampleRate: SAMPLE_RATE, bitDepth: 32 };
}

function splitChunk(chunk: Block, parts: number): Array<Block> {
	const frames = chunk.samples[0]?.length ?? 0;
	const size = Math.ceil(frames / parts);
	const out: Array<Block> = [];

	for (let start = 0; start < frames; start += size) {
		const end = Math.min(start + size, frames);

		out.push({
			samples: chunk.samples.map((ch) => ch.subarray(start, end)),
			offset: chunk.offset + start,
			sampleRate: chunk.sampleRate,
			bitDepth: chunk.bitDepth,
		});
	}

	return out;
}

describe("pad", () => {
	it("prepends leading silence and appends trailing silence with exact lengths", async () => {
		const inputFrames = 1000;
		const before = 0.02;
		const after = 0.03;
		const leading = Math.round(before * SAMPLE_RATE);
		const trailing = Math.round(after * SAMPLE_RATE);
		const input = makeRamp(inputFrames);
		const original = input.samples[0]!.slice();

		const out = await runPad({ before, after }, [input]);

		expect(out.length).toBe(leading + inputFrames + trailing);

		for (let i = 0; i < leading; i++) expect(out[i]).toBe(0);

		for (let i = 0; i < inputFrames; i++) expect(out[leading + i]).toBe(original[i]);

		for (let i = 0; i < trailing; i++) expect(out[leading + inputFrames + i]).toBe(0);
	});

	it("pads only the start when after is 0", async () => {
		const inputFrames = 500;
		const before = 0.01;
		const leading = Math.round(before * SAMPLE_RATE);
		const input = makeRamp(inputFrames);
		const original = input.samples[0]!.slice();

		const out = await runPad({ before, after: 0 }, [input]);

		expect(out.length).toBe(leading + inputFrames);
		for (let i = 0; i < leading; i++) expect(out[i]).toBe(0);
		for (let i = 0; i < inputFrames; i++) expect(out[leading + i]).toBe(original[i]);
	});

	it("pads only the end when before is 0", async () => {
		const inputFrames = 500;
		const after = 0.01;
		const trailing = Math.round(after * SAMPLE_RATE);
		const input = makeRamp(inputFrames);
		const original = input.samples[0]!.slice();

		const out = await runPad({ before: 0, after }, [input]);

		expect(out.length).toBe(inputFrames + trailing);
		for (let i = 0; i < inputFrames; i++) expect(out[i]).toBe(original[i]);
		for (let i = 0; i < trailing; i++) expect(out[inputFrames + i]).toBe(0);
	});

	it("is identity when before and after are both 0", async () => {
		const input = makeRamp(1000);
		const original = input.samples[0]!.slice();

		const out = await runPad({ before: 0, after: 0 }, [input]);

		expect(out.length).toBe(original.length);
		for (let i = 0; i < original.length; i++) expect(out[i]).toBe(original[i]);
	});

	it("emits nothing for empty input", async () => {
		const out = await runPad({ before: 0.5, after: 0.5 }, []);

		expect(out.length).toBe(0);
	});

	it("produces identical output regardless of input chunking (chunking invariance)", async () => {
		const props = { before: 0.02, after: 0.02 };

		const single = await runPad(props, [makeRamp(1300)]);
		const multi = await runPad(props, splitChunk(makeRamp(1300), 9));

		expect(multi.length).toBe(single.length);
		for (let i = 0; i < single.length; i++) expect(multi[i]).toBe(single[i]);
	});

	it("preserves stereo channels independently", async () => {
		const frames = 400;
		const before = 0.01;
		const leading = Math.round(before * SAMPLE_RATE);
		const left = new Float32Array(frames);
		const right = new Float32Array(frames);

		for (let i = 0; i < frames; i++) {
			left[i] = 0.2 + i * 0.0001;
			right[i] = -0.2 - i * 0.0001;
		}

		const input: Block = { samples: [left, right], offset: 0, sampleRate: SAMPLE_RATE, bitDepth: 32 };

		const node = pad({ before, after: 0 });
		const stream = node.createStream() as PadStream;
		const chunks = await drain(await stream._setup(readableFrom([input]), context()));

		const outLeft = concatChannel(chunks, 0);
		const outRight = concatChannel(chunks, 1);

		expect(outLeft.length).toBe(leading + frames);
		expect(outRight.length).toBe(leading + frames);

		for (let i = 0; i < leading; i++) {
			expect(outLeft[i]).toBe(0);
			expect(outRight[i]).toBe(0);
		}

		for (let i = 0; i < frames; i++) {
			expect(outLeft[leading + i]).toBe(left[i]);
			expect(outRight[leading + i]).toBe(right[i]);
		}
	});
});
