import { describe, expect, it } from "vitest";
import type { Block, StreamContext } from "./node";
import type { ProgressPayload, StreamPhase } from "./stream";
import { BufferedTransformStream, WHOLE_FILE, type TransformNodeProperties } from "./transform";

function createChunk(value: number, offset: number, frames: number): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate: 44100, bitDepth: 32 };
}

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

const FLUSH_MARKER = -99;

class FlushingTransformStream extends BufferedTransformStream {
	flushCalls = 0;
	private readonly flushChunkCount: number;

	constructor(properties: TransformNodeProperties, flushChunkCount = 2) {
		super(properties);
		this.flushChunkCount = flushChunkCount;
	}

	override _flush(): Array<Block> {
		this.flushCalls += 1;

		return Array.from({ length: this.flushChunkCount }, (_unused, i) => createChunk(FLUSH_MARKER, i, 4));
	}
}

async function run(
	bufferSize: number,
	chunks: Array<Block>,
	flushChunkCount = 2,
	onStream?: (stream: FlushingTransformStream) => void,
): Promise<{ output: Array<Block>; stream: FlushingTransformStream }> {
	const stream = new FlushingTransformStream({ bufferSize }, flushChunkCount);

	onStream?.(stream);

	const output = await stream._setup(readableFrom(chunks), context());

	return { output: await drain(output), stream };
}

function isFlushChunk(chunk: Block): boolean {
	return chunk.samples[0]?.[0] === FLUSH_MARKER;
}

function flushChunksStrictlyLast(output: Array<Block>): boolean {
	const firstFlush = output.findIndex(isFlushChunk);

	if (firstFlush === -1) return false;

	return output.slice(0, firstFlush).every((c) => !isFlushChunk(c)) && output.slice(firstFlush).every(isFlushChunk);
}

function passThroughFrames(output: Array<Block>): number {
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

async function runProgress(bufferSize: number, chunks: Array<Block>): Promise<Array<ProgressPayload>> {
	const stream = new BufferedTransformStream({ bufferSize });
	const events: Array<ProgressPayload> = [];

	stream.events.on("progress", (payload) => events.push(payload));

	const output = await stream._setup(readableFrom(chunks), context());
	await drain(output);

	return events;
}

function phases(events: Array<ProgressPayload>): Array<StreamPhase> {
	return events.map((e) => e.phase);
}

describe("BufferedTransformStream phase emission", () => {
	it("WHOLE_FILE: buffer → forced process start/end → emit, in order", async () => {
		const input = [createChunk(1, 0, 100), createChunk(2, 100, 100)];
		const events = await runProgress(WHOLE_FILE, input);

		const seq = phases(events);
		const firstProcess = seq.indexOf("process");
		const lastProcess = seq.lastIndexOf("process");

		expect(seq).toContain("buffer");
		expect(seq).toContain("process");
		expect(seq).toContain("emit");

		// two forced process events: start (framesDone 0) then end (framesDone = frames)
		const processEvents = events.filter((e) => e.phase === "process");
		expect(processEvents).toHaveLength(2);
		expect(processEvents[0]?.framesDone).toBe(0);
		expect(processEvents[1]?.framesDone).toBe(200);

		// all buffer events precede the first process; all emit events follow the last process
		expect(seq.slice(0, firstProcess).every((p) => p === "buffer")).toBe(true);
		expect(seq.slice(lastProcess + 1).every((p) => p === "emit")).toBe(true);
	});

	it("bufferSize 0: buffer and emit only, no process events", async () => {
		const input = [createChunk(1, 0, 100), createChunk(2, 100, 100)];
		const events = await runProgress(0, input);

		expect(events.some((e) => e.phase === "process")).toBe(false);
		expect(events.some((e) => e.phase === "buffer")).toBe(true);
		expect(events.some((e) => e.phase === "emit")).toBe(true);
	});

	it("finite block: no process events, forced final emit at flush and no per-block spam", async () => {
		const input = [createChunk(1, 0, 100), createChunk(2, 100, 50)];
		const events = await runProgress(64, input);

		expect(events.some((e) => e.phase === "process")).toBe(false);

		// context() has no durationFrames → emit uses the unknown-total quantum (480_000).
		// The first block crosses boundary 0 (throttled emit); no further boundary is crossed
		// until the forced final at flush. So emit events are bounded (not one per block), and
		// the last carries the cumulative total.
		const emitEvents = events.filter((e) => e.phase === "emit");
		expect(emitEvents.length).toBeLessThanOrEqual(2);
		expect(emitEvents.at(-1)?.framesDone).toBe(150);
	});
});
