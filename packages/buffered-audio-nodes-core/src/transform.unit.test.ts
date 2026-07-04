import { describe, expect, it } from "vitest";
import type { AudioChunk, StreamContext } from "./node";
import { BufferedTransformStream, WHOLE_FILE, type TransformNodeProperties } from "./transform";

function createChunk(value: number, offset: number, frames: number): AudioChunk {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate: 44100, bitDepth: 32 };
}

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

const FLUSH_MARKER = -99;

class FlushingTransformStream extends BufferedTransformStream {
	flushCalls = 0;
	private readonly flushChunkCount: number;

	constructor(properties: TransformNodeProperties, flushChunkCount = 2) {
		super(properties);
		this.flushChunkCount = flushChunkCount;
	}

	override _flush(): Array<AudioChunk> {
		this.flushCalls += 1;

		return Array.from({ length: this.flushChunkCount }, (_unused, i) => createChunk(FLUSH_MARKER, i, 4));
	}
}

async function run(
	bufferSize: number,
	chunks: Array<AudioChunk>,
	flushChunkCount = 2,
	onStream?: (stream: FlushingTransformStream) => void,
): Promise<{ output: Array<AudioChunk>; stream: FlushingTransformStream }> {
	const stream = new FlushingTransformStream({ bufferSize }, flushChunkCount);

	onStream?.(stream);

	const output = await stream._setup(readableFrom(chunks), context());

	return { output: await drain(output), stream };
}

function isFlushChunk(chunk: AudioChunk): boolean {
	return chunk.samples[0]?.[0] === FLUSH_MARKER;
}

function flushChunksStrictlyLast(output: Array<AudioChunk>): boolean {
	const firstFlush = output.findIndex(isFlushChunk);

	if (firstFlush === -1) return false;

	return output.slice(0, firstFlush).every((c) => !isFlushChunk(c)) && output.slice(firstFlush).every(isFlushChunk);
}

function passThroughFrames(output: Array<AudioChunk>): number {
	return output.filter((c) => !isFlushChunk(c)).reduce((sum, c) => sum + (c.samples[0]?.length ?? 0), 0);
}

describe("BufferedTransformStream._flush", () => {
	it("bufferSize 0: flush chunks come after all pass-through chunks, called once", async () => {
		const input = [createChunk(1, 0, 10), createChunk(2, 10, 10)];
		const { output, stream } = await run(0, input);

		expect(stream.flushCalls).toBe(1);

		const passThrough = output.filter((c) => !isFlushChunk(c));
		const flushed = output.filter(isFlushChunk);

		expect(passThrough).toHaveLength(2);
		expect(flushed).toHaveLength(2);
		expect(flushChunksStrictlyLast(output)).toBe(true);
	});

	it("bufferSize WHOLE_FILE: flush chunks are last, called once after emission", async () => {
		const input = [createChunk(1, 0, 10), createChunk(2, 10, 10)];
		const { output, stream } = await run(WHOLE_FILE, input);

		expect(stream.flushCalls).toBe(1);
		expect(output.filter(isFlushChunk)).toHaveLength(2);
		expect(flushChunksStrictlyLast(output)).toBe(true);
		expect(passThroughFrames(output)).toBe(20);
	});

	it("bufferSize N (finite): flush chunks follow the trailing-partial emission, after finished sees the flush", async () => {
		const input = [createChunk(1, 0, 100), createChunk(2, 100, 50)];

		let flushCallsAtFinished = -1;
		const { output, stream } = await run(64, input, 2, (s) => {
			s.events.on("finished", () => (flushCallsAtFinished = s.flushCalls));
		});

		expect(stream.flushCalls).toBe(1);
		expect(output.filter(isFlushChunk)).toHaveLength(2);
		expect(flushChunksStrictlyLast(output)).toBe(true);
		expect(passThroughFrames(output)).toBe(150);
		expect(flushCallsAtFinished).toBe(1);
	});

	it.each([0, WHOLE_FILE, 64])("empty upstream (bufferSize %s): flush still called exactly once", async (bufferSize) => {
		const { output, stream } = await run(bufferSize, []);

		expect(stream.flushCalls).toBe(1);
		expect(output.filter(isFlushChunk)).toHaveLength(2);
		expect(output.every(isFlushChunk)).toBe(true);
	});

	it("default _flush (undefined) leaves output unchanged", async () => {
		const input = [createChunk(1, 0, 10), createChunk(2, 10, 10)];
		const stream = new BufferedTransformStream({ bufferSize: 0 });
		const output = await drain(await stream._setup(readableFrom(input), context()));

		expect(output).toHaveLength(2);
		expect(output[0]?.samples[0]?.[0]).toBe(1);
		expect(output[1]?.samples[0]?.[0]).toBe(2);
	});
});
