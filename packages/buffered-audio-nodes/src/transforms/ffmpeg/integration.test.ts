import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "@buffered-audio/core";
import { createBlock, createTestSetupContext, createTestStreamContext, readableFrom } from "@buffered-audio/core/testing";
import { ffmpeg, FfmpegStream } from ".";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: childProcessMocks.spawn,
}));

const SAMPLE_RATE = 44100;
const BLOCK_FRAMES = 8;
const PIPE_FRAMES = 16384;

function createMockChild(): {
	readonly child: EventEmitter;
	readonly stdin: PassThrough;
	readonly stdout: Readable;
	readonly stderr: PassThrough;
	readonly kill: ReturnType<typeof vi.fn>;
	readonly exit: (code: number) => void;
} {
	const child = new EventEmitter();
	const stdin = new PassThrough();
	const stdout = new Readable({ read: () => undefined });
	const stderr = new PassThrough();
	let exitCode: number | null = null;
	let killed = false;
	const settleExit = (code: number): void => {
		exitCode = code;
		child.emit("exit", code, null);
		child.emit("close", code, null);
	};
	const kill = vi.fn(() => {
		killed = true;
		queueMicrotask(() => settleExit(0));

		return true;
	});

	Object.defineProperties(child, {
		stdin: { value: stdin },
		stdout: { value: stdout },
		stderr: { value: stderr },
		exitCode: { get: () => exitCode },
		killed: { get: () => killed },
		kill: { value: kill },
	});

	return { child, stdin, stdout, stderr, kill, exit: settleExit };
}

function pcmBytes(value: number, frames: number): Buffer {
	const floats = new Float32Array(frames).fill(value);

	return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function inputBlocks(count: number): Array<Block> {
	const blocks: Array<Block> = [];

	for (let index = 0; index < count; index++) {
		blocks.push(createBlock(0.5, index * BLOCK_FRAMES, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));
	}

	return blocks;
}

function createBridge(input: ReadableStream<Block>): { readable: ReadableStream<Block> } {
	const { context } = createTestStreamContext();
	const node = ffmpeg({ ffmpegPath: "ffmpeg", args: ["-af", "anull"] });
	const stream = new FfmpegStream(node, context);

	stream._setup(createTestSetupContext());

	return { readable: stream._pipe(input) };
}

function manualInput(): { readonly readable: ReadableStream<Block>; readonly push: (block: Block) => void; readonly close: () => void } {
	let controller: ReadableStreamDefaultController<Block> | undefined;
	const readable = new ReadableStream<Block>({
		start: (streamController) => {
			controller = streamController;
		},
	});

	return {
		readable,
		push: (block) => controller?.enqueue(block),
		close: () => controller?.close(),
	};
}

function tick(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

const PARKED = Symbol("parked");

async function ticks(count: number): Promise<typeof PARKED> {
	for (let index = 0; index < count; index++) await tick();

	return PARKED;
}

function served(result: ReadableStreamReadResult<Block> | typeof PARKED): ReadableStreamReadResult<Block> {
	if (result === PARKED) throw new Error("bridge parked with stdout bytes buffered instead of serving them");

	return result;
}

function raceParked(read: Promise<ReadableStreamReadResult<Block>>): Promise<ReadableStreamReadResult<Block> | typeof PARKED> {
	return Promise.race([read, ticks(50)]);
}

afterEach(() => {
	childProcessMocks.spawn.mockReset();
	vi.restoreAllMocks();
});

describe("FfmpegStream bridge", () => {
	it("leaves stdout unread while downstream demand is stalled", async () => {
		const { child, stdin, stdout } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		stdout.push(pcmBytes(0.25, BLOCK_FRAMES));

		const readSpy = vi.spyOn(stdout, "read");
		// Node's own maybeReadMore bookkeeping calls read(0); only the bridge calls read() with no argument.
		const bridgeReads = (): number => readSpy.mock.calls.filter((call) => call[0] === undefined).length;
		const { readable } = createBridge(readableFrom(inputBlocks(4)));
		const reader = readable.getReader();

		await tick();

		const baselineReads = bridgeReads();

		expect(baselineReads).toBeGreaterThan(0);

		stdout.push(pcmBytes(0.75, BLOCK_FRAMES));
		stdout.push(pcmBytes(0.9, BLOCK_FRAMES));

		await tick();

		// The eagerly-prefetched block fills the output queue; with no further demand the bridge never touches stdout again.
		expect(bridgeReads()).toBe(baselineReads);

		// The pushed bytes stay in the pipe rather than accumulating in bridge state.
		expect(stdout.readableLength).toBe(2 * BLOCK_FRAMES * 4);

		const first = await reader.read();

		expect(first.done).toBe(false);
		expect(first.value?.samples[0]?.[0]).toBeCloseTo(0.25, 5);

		await reader.cancel();
	});

	it("keeps writing stdin while stdout stays silent, then yields once output appears", async () => {
		const { child, stdin, stdout, exit } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const writeSpy = vi.spyOn(stdin, "write").mockReturnValue(true);
		const { readable } = createBridge(readableFrom(inputBlocks(3)));
		const reader = readable.getReader();
		const pending = reader.read();

		await tick();

		// FIR prefill: every input block reaches stdin even though ffmpeg has emitted nothing.
		expect(writeSpy).toHaveBeenCalledTimes(3);

		stdout.push(pcmBytes(0.25, BLOCK_FRAMES));

		const first = await pending;

		expect(first.done).toBe(false);
		expect(first.value?.samples[0]?.[0]).toBeCloseTo(0.25, 5);

		stdout.push(null);
		await tick();
		exit(0);

		expect((await reader.read()).done).toBe(true);
	});

	it("serves stdout while a stdin write is parked awaiting drain", async () => {
		const { child, stdin, stdout, exit } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const writeSpy = vi.spyOn(stdin, "write").mockReturnValue(false);
		const { readable } = createBridge(readableFrom(inputBlocks(2)));
		const reader = readable.getReader();
		const pending = reader.read();

		await tick();

		expect(writeSpy).toHaveBeenCalledTimes(1);

		stdout.push(pcmBytes(0.25, BLOCK_FRAMES));

		const first = await pending;

		// The block came out while the write was still parked — the race is what keeps the child from deadlocking.
		expect(first.done).toBe(false);
		expect(first.value?.samples[0]?.[0]).toBeCloseTo(0.25, 5);
		expect(writeSpy).toHaveBeenCalledTimes(1);

		await tick();
		stdin.emit("drain");
		await tick();

		expect(writeSpy).toHaveBeenCalledTimes(2);

		writeSpy.mockReturnValue(true);
		stdin.emit("drain");
		await tick();
		stdout.push(null);
		await tick();
		exit(0);

		await reader.cancel();
	});

	it("serves stdout buffered past the pipe high-water mark while a stdin write is parked", async () => {
		const { child, stdin, stdout } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const writeResults = [true];

		vi.spyOn(stdin, "write").mockImplementation(() => writeResults.shift() ?? false);

		const input = manualInput();
		const { readable } = createBridge(input.readable);
		const reader = readable.getReader();

		input.push(createBlock(0.5, 0, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));

		await tick();

		// A real child pipe hands over 64 KiB against a 16 KiB high-water mark, so 'readable' disarms until a read drains it.
		stdout.push(pcmBytes(0.25, PIPE_FRAMES));

		await tick();

		expect(stdout.readableLength).toBeGreaterThan(stdout.readableHighWaterMark);

		// The child is blocked writing its full stdout pipe, so it has stopped reading stdin and no 'drain' will ever fire.
		input.push(createBlock(0.5, BLOCK_FRAMES, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));

		const first = served(await raceParked(reader.read()));

		expect(first.done).toBe(false);
		expect(first.value?.samples[0]?.length).toBe(PIPE_FRAMES);
		expect(first.value?.samples[0]?.[0]).toBeCloseTo(0.25, 5);

		await reader.cancel();
	});

	it("streams the tail incrementally before the child exits", async () => {
		const { child, stdin, stdout, exit } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		const { readable } = createBridge(readableFrom(inputBlocks(1)));
		const reader = readable.getReader();

		await tick();

		const values: Array<number | undefined> = [];

		for (const value of [0.1, 0.2, 0.3]) {
			stdout.push(pcmBytes(value, BLOCK_FRAMES));

			const result = await reader.read();

			values.push(result.value?.samples[0]?.[0]);
		}

		// All three tail blocks arrived before 'exit' ever fired.
		expect(values[0]).toBeCloseTo(0.1, 5);
		expect(values[1]).toBeCloseTo(0.2, 5);
		expect(values[2]).toBeCloseTo(0.3, 5);
		expect(child.listenerCount("exit")).toBeGreaterThan(0);

		stdout.push(null);
		await tick();
		exit(0);

		const end = await reader.read();

		expect(end.done).toBe(true);
	});

	it("drains stdout buffered past the pipe high-water mark after input ends", async () => {
		const { child, stdin, stdout, exit } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		const input = manualInput();
		const { readable } = createBridge(input.readable);
		const reader = readable.getReader();

		input.push(createBlock(0.5, 0, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));

		await tick();

		stdout.push(pcmBytes(0.3, PIPE_FRAMES));

		await tick();

		expect(stdout.readableLength).toBeGreaterThan(stdout.readableHighWaterMark);

		input.close();

		const tail = served(await raceParked(reader.read()));

		expect(tail.done).toBe(false);
		expect(tail.value?.samples[0]?.length).toBe(PIPE_FRAMES);
		expect(tail.value?.samples[0]?.[0]).toBeCloseTo(0.3, 5);

		stdout.push(null);
		await tick();
		exit(0);

		expect((await reader.read()).done).toBe(true);
	});

	it("errors the output with the stderr excerpt on a nonzero exit", async () => {
		const { child, stdin, stdout, stderr, exit } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		const { readable } = createBridge(readableFrom(inputBlocks(1)));
		const reader = readable.getReader();

		await tick();

		stderr.write(Buffer.from("Invalid argument"));
		await tick();

		stdout.push(null);
		await tick();
		exit(1);

		await expect(reader.read()).rejects.toThrow("ffmpeg exited 1: Invalid argument");
	});

	it("terminates the child when the consumer cancels mid-stream", async () => {
		const { child, stdin, stdout, kill } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		stdout.push(pcmBytes(0.25, BLOCK_FRAMES));

		const { readable } = createBridge(readableFrom(inputBlocks(4)));
		const reader = readable.getReader();
		const first = await reader.read();

		expect(first.done).toBe(false);

		await reader.cancel();

		expect(kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("propagates a non-EPIPE stdin error to the next transform", async () => {
		const { child, stdin, stdout } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		stdout.push(pcmBytes(0.25, BLOCK_FRAMES));

		const { readable } = createBridge(readableFrom(inputBlocks(4)));
		const reader = readable.getReader();

		await reader.read();

		stdin.emit("error", Object.assign(new Error("disk full"), { code: "ENOSPC" }));

		await expect(reader.read()).rejects.toThrow("ffmpeg stdin error: disk full");
	});
});
