import { describe, it, expect } from "vitest";
import type { AudioChunk, StreamContext } from "@buffered-audio/core";
import { trim, TrimStream } from ".";

const SAMPLE_RATE = 44100;

function context(): StreamContext {
	return { executionProviders: ["cpu"], memoryLimit: 256 * 1024 * 1024, highWaterMark: 16, visited: new Set() };
}

function readableFrom(chunks: Array<AudioChunk>): ReadableStream<AudioChunk> {
	let index = 0;

	return new ReadableStream<AudioChunk>({
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

async function drain(readable: ReadableStream<AudioChunk>): Promise<Array<AudioChunk>> {
	const out: Array<AudioChunk> = [];
	const reader = readable.getReader();

	for (;;) {
		const { done, value } = await reader.read();

		if (done) break;
		if (value) out.push(value);
	}

	return out;
}

function concatChannel(chunks: Array<AudioChunk>, channel: number): Float32Array {
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

async function runTrim(properties: Parameters<typeof trim>[0], input: Array<AudioChunk>, channel = 0): Promise<Float32Array> {
	const node = trim(properties);
	const stream = node.createStream() as TrimStream;
	const output = await stream._setup(readableFrom(input), context());

	return concatChannel(await drain(output), channel);
}

function makeChunk(leadingSilence: number, signalFrames: number, trailingSilence: number, amplitude: number, offset = 0): AudioChunk {
	const frames = leadingSilence + signalFrames + trailingSilence;
	const channel = new Float32Array(frames);

	for (let i = leadingSilence; i < leadingSilence + signalFrames; i++) channel[i] = amplitude;

	return { samples: [channel], offset, sampleRate: SAMPLE_RATE, bitDepth: 32 };
}

function splitChunk(chunk: AudioChunk, parts: number): Array<AudioChunk> {
	const frames = chunk.samples[0]?.length ?? 0;
	const size = Math.ceil(frames / parts);
	const out: Array<AudioChunk> = [];

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

describe("trim", () => {
	it("removes leading and trailing silence to the exact keep region (margin 0)", async () => {
		const lead = 1000;
		const signal = 500;
		const trail = 800;
		const input = makeChunk(lead, signal, trail, 0.5);

		const out = await runTrim({ margin: 0 }, [input]);

		expect(out.length).toBe(signal);

		for (let i = 0; i < signal; i++) expect(out[i]).toBe(0.5);
	});

	it("keeps keep-region content sample-exactly for a ramped signal", async () => {
		const lead = 300;
		const signal = 400;
		const trail = 300;
		const frames = lead + signal + trail;
		const channel = new Float32Array(frames);

		for (let i = 0; i < signal; i++) channel[lead + i] = 0.1 + (i / signal) * 0.8;

		const input: AudioChunk = { samples: [channel], offset: 0, sampleRate: SAMPLE_RATE, bitDepth: 32 };
		const out = await runTrim({ margin: 0 }, [input]);

		expect(out.length).toBe(signal);

		for (let i = 0; i < signal; i++) expect(out[i]).toBe(channel[lead + i]);
	});

	it("applies the margin symmetrically around the keep region", async () => {
		const lead = 2000;
		const signal = 500;
		const trail = 2000;
		const margin = 0.01;
		const marginFrames = Math.round(margin * SAMPLE_RATE);
		const input = makeChunk(lead, signal, trail, 0.5);

		const out = await runTrim({ margin }, [input]);

		expect(out.length).toBe(signal + 2 * marginFrames);

		for (let i = 0; i < marginFrames; i++) expect(out[i]).toBe(0);
		for (let i = 0; i < marginFrames; i++) expect(out[out.length - 1 - i]).toBe(0);

		for (let i = 0; i < signal; i++) expect(out[marginFrames + i]).toBe(0.5);
	});

	it("clamps the leading margin at frame 0", async () => {
		const lead = 100;
		const signal = 500;
		const trail = 2000;
		const margin = 0.01;
		const marginFrames = Math.round(margin * SAMPLE_RATE);
		const input = makeChunk(lead, signal, trail, 0.5);

		const out = await runTrim({ margin }, [input]);

		expect(out.length).toBe(lead + signal + marginFrames);

		for (let i = 0; i < lead; i++) expect(out[i]).toBe(0);
		for (let i = 0; i < signal; i++) expect(out[lead + i]).toBe(0.5);
	});

	it("trims only the start when end is disabled", async () => {
		const lead = 1000;
		const signal = 500;
		const trail = 800;
		const input = makeChunk(lead, signal, trail, 0.5);

		const out = await runTrim({ margin: 0, start: true, end: false }, [input]);

		expect(out.length).toBe(signal + trail);

		for (let i = 0; i < signal; i++) expect(out[i]).toBe(0.5);
		for (let i = 0; i < trail; i++) expect(out[signal + i]).toBe(0);
	});

	it("trims only the end when start is disabled", async () => {
		const lead = 1000;
		const signal = 500;
		const trail = 800;
		const input = makeChunk(lead, signal, trail, 0.5);

		const out = await runTrim({ margin: 0, start: false, end: true }, [input]);

		expect(out.length).toBe(lead + signal);

		for (let i = 0; i < lead; i++) expect(out[i]).toBe(0);
		for (let i = 0; i < signal; i++) expect(out[lead + i]).toBe(0.5);
	});

	it("is identity when start and end are both disabled", async () => {
		const input = makeChunk(1000, 500, 800, 0.5);
		const original = input.samples[0]!.slice();

		const out = await runTrim({ margin: 0, start: false, end: false }, [input]);

		expect(out.length).toBe(original.length);
		for (let i = 0; i < original.length; i++) expect(out[i]).toBe(original[i]);
	});

	it("is identity when there is no silence to trim", async () => {
		const input = makeChunk(0, 1500, 0, 0.5);
		const original = input.samples[0]!.slice();

		const out = await runTrim({ margin: 0 }, [input]);

		expect(out.length).toBe(original.length);
		for (let i = 0; i < original.length; i++) expect(out[i]).toBe(original[i]);
	});

	it("emits nothing for all-silent input", async () => {
		const frames = 2000;
		const input: AudioChunk = { samples: [new Float32Array(frames)], offset: 0, sampleRate: SAMPLE_RATE, bitDepth: 32 };

		const out = await runTrim({ margin: 0 }, [input]);

		expect(out.length).toBe(0);
	});

	it("does not treat exactly-at-threshold samples as signal (strict threshold)", async () => {
		const frames = 2000;
		const threshold = 0.02;
		const channel = new Float32Array(frames).fill(threshold); // == threshold, not > threshold

		const input: AudioChunk = { samples: [channel], offset: 0, sampleRate: SAMPLE_RATE, bitDepth: 32 };
		const out = await runTrim({ margin: 0, threshold }, [input]);

		expect(out.length).toBe(0);
	});

	it("produces identical output regardless of input chunking (chunking invariance)", async () => {
		const whole = makeChunk(1000, 500, 800, 0.5);

		const single = await runTrim({ margin: 0.01 }, [whole]);
		const multi = await runTrim({ margin: 0.01 }, splitChunk(makeChunk(1000, 500, 800, 0.5), 7));

		expect(multi.length).toBe(single.length);
		for (let i = 0; i < single.length; i++) expect(multi[i]).toBe(single[i]);
	});

	it("trims silence across a chunk boundary (multi-chunk signal)", async () => {
		const whole = makeChunk(600, 900, 600, 0.5);
		const out = await runTrim({ margin: 0 }, splitChunk(whole, 4));

		expect(out.length).toBe(900);
		for (let i = 0; i < 900; i++) expect(out[i]).toBe(0.5);
	});
});
