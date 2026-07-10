import { describe, it, expect } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, createTestSetupContext, createTestStreamContext, drainBlocks, readableFrom, runTransformStream } from "@buffered-audio/core/testing";
import { pad, PadStream } from ".";

const SAMPLE_RATE = 44100;

async function runPad(properties: Parameters<typeof pad>[0], input: Array<Block>, channel = 0): Promise<Float32Array> {
	const node = pad(properties);
	const stream = new PadStream(node, createTestStreamContext().context);
	const output = await stream.setup(readableFrom(input), createTestSetupContext());

	return channelSamples(await drainBlocks(output), channel);
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

	it("pads leading and trailing silence through the harness", async () => {
		const before = 0.02;
		const after = 0.03;
		const leading = Math.round(before * SAMPLE_RATE);
		const trailing = Math.round(after * SAMPLE_RATE);
		const input = makeRamp(1000);

		const { blocks } = await runTransformStream(pad({ before, after }), [input]);
		const out = channelSamples(blocks, 0);

		expect(out.length).toBe(leading + 1000 + trailing);
		expect(out[0]).toBe(0);
		expect(out[out.length - 1]).toBe(0);
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
		const stream = new PadStream(node, createTestStreamContext().context);
		const chunks = await drainBlocks(await stream.setup(readableFrom([input]), createTestSetupContext()));

		const outLeft = channelSamples(chunks, 0);
		const outRight = channelSamples(chunks, 1);

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
