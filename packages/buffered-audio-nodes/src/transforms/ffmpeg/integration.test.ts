import { EventEmitter, getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block, RenderEvents } from "@buffered-audio/core";
import {
	createBlock,
	createTestSetupContext,
	createTestStreamContext,
	drainBlocks,
	readableFrom,
} from "@buffered-audio/core/testing";
import { binaries, hasBinaryFixtures } from "../../utils/test-binaries";
import { cli, CliStream } from "../cli";
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
	readonly exit: (code: number | null, signal?: NodeJS.Signals) => void;
	readonly exitOnly: (code: number) => void;
	readonly close: () => void;
} {
	const child = new EventEmitter();
	const stdin = new PassThrough();
	// A real child stdout pipe is a 16 KiB socket; pin it so backpressure tests do not depend on the platform's default highWaterMark (16 KiB on Windows, 64 KiB on Linux).
	const stdout = new Readable({ read: () => undefined, highWaterMark: 16384 });
	const stderr = new PassThrough();
	let exitCode: number | null = null;
	let signalCode: NodeJS.Signals | null = null;
	let killed = false;
	const settleExit = (code: number | null, signal: NodeJS.Signals | null = null): void => {
		exitCode = code;
		signalCode = signal;
		child.emit("exit", code, signal);
		child.emit("close", code, signal);
	};
	const kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
		killed = true;
		queueMicrotask(() => settleExit(null, signal));

		return true;
	});

	Object.defineProperties(child, {
		stdin: { value: stdin },
		stdout: { value: stdout },
		stderr: { value: stderr },
		exitCode: { get: () => exitCode },
		signalCode: { get: () => signalCode },
		killed: { get: () => killed },
		kill: { value: kill },
	});

	// Emits 'exit' alone: a real child's 'close' follows once its stdio pipes have drained, which can be after 'exit'.
	const exitOnly = (code: number): void => {
		exitCode = code;
		child.emit("exit", code, null);
	};
	const close = (): void => {
		child.emit("close", exitCode, signalCode);
	};

	return { child, stdin, stdout, stderr, kill, exit: settleExit, exitOnly, close };
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

function createBridge(
	input: ReadableStream<Block>,
	options?: { readonly ffmpegPath?: string; readonly signal?: AbortSignal },
): { readable: ReadableStream<Block>; stream: FfmpegStream; events: RenderEvents } {
	const { context, events } = createTestStreamContext();
	const node = ffmpeg({ ffmpegPath: options?.ffmpegPath ?? "ffmpeg", args: ["-af", "anull"] });
	const stream = new FfmpegStream(node, context);

	stream._setup(createTestSetupContext({ signal: options?.signal }));

	return { readable: stream._pipe(input), stream, events };
}

function manualInput(): {
	readonly readable: ReadableStream<Block>;
	readonly push: (block: Block) => void;
	readonly close: () => void;
} {
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

function raceParked(
	read: Promise<ReadableStreamReadResult<Block>>,
): Promise<ReadableStreamReadResult<Block> | typeof PARKED> {
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

		// The re-pull after the served block parks on the drain race again; the cancel has to wake it.
		await tick();
		await expect(reader.cancel()).resolves.toBeUndefined();
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

	it("includes stderr that arrives between the child's exit and close", async () => {
		const { child, stdin, stdout, stderr, exitOnly, close } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		const { readable } = createBridge(readableFrom(inputBlocks(1)));
		const pending = readable.getReader().read();

		await tick();

		stdout.push(null);
		exitOnly(1);
		await tick();

		stderr.write(Buffer.from("late detail"));
		await tick();
		close();

		await expect(pending).rejects.toThrow("ffmpeg exited 1: late detail");
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

		expect(kill).toHaveBeenNthCalledWith(1, "SIGKILL");
	});

	it("errors with the exit error carrying stderr when the child exits non-zero while a write is parked", async () => {
		const { child, stdin, stderr, exit } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const writeSpy = vi.spyOn(stdin, "write").mockReturnValue(false);
		const { readable } = createBridge(readableFrom(inputBlocks(2)));
		const reader = readable.getReader();
		const pending = reader.read();

		await tick();

		expect(writeSpy).toHaveBeenCalledTimes(1);

		stderr.write(Buffer.from("Conversion failed"));
		await tick();
		// Only the exit can wake the parked write here.
		exit(1);

		await expect(pending).rejects.toThrow("ffmpeg exited 1: Conversion failed");
	});

	it("throws the exit error ahead of a stdin error stored while the child ran", async () => {
		const { child, stdin, stdout, exit } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		const input = manualInput();
		const { readable } = createBridge(input.readable);
		const reader = readable.getReader();

		input.push(createBlock(0.5, 0, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));
		await tick();

		stdin.emit("error", Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" }));
		stdout.push(null);
		exit(1);

		input.push(createBlock(0.5, BLOCK_FRAMES, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));

		await expect(reader.read()).rejects.toThrow("ffmpeg exited 1");
	});

	it("moves on at once when a write parks on a stdin that is already destroyed", async () => {
		const { child, stdin } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const writeSpy = vi.spyOn(stdin, "write").mockReturnValue(false);
		const input = manualInput();
		const { readable } = createBridge(input.readable);
		const reader = readable.getReader();

		stdin.destroy();
		await tick();

		input.push(createBlock(0.5, 0, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));
		input.push(createBlock(0.5, BLOCK_FRAMES, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));
		await ticks(5);

		// The child still runs, and no 'drain' or 'close' can follow on a stdin destroyed before the write parked.
		expect(writeSpy).toHaveBeenCalledTimes(2);

		await reader.cancel();
	});

	it("never spawns when the render aborts while the first block is being delivered", async () => {
		const controller = new AbortController();
		const { readable, events } = createBridge(readableFrom(inputBlocks(2)), { signal: controller.signal });

		events.on("started", () => controller.abort(new Error("render failed")));

		await expect(readable.getReader().read()).rejects.toThrow("render failed");
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
	});

	it.skipIf(!hasBinaryFixtures("ffmpeg"))(
		"cancels a real ffmpeg child mid-stream well under a second",
		async () => {
			const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");

			childProcessMocks.spawn.mockImplementation(spawn);

			let offset = 0;
			const endless = new ReadableStream<Block>({
				pull: (controller) => {
					controller.enqueue(createBlock(0.25, offset, 4096, { channels: 1, sampleRate: SAMPLE_RATE }));
					offset += 4096;
				},
			});
			const { readable } = createBridge(endless, { ffmpegPath: binaries.ffmpeg });
			const reader = readable.getReader();

			expect((await reader.read()).done).toBe(false);

			const started = performance.now();

			await reader.cancel();

			expect(performance.now() - started).toBeLessThan(1000);
		},
		20_000,
	);

	it("does not hang on the next block after the child exits with stdin destroyed", async () => {
		const { child, stdin, stdout, exit } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const writeSpy = vi.spyOn(stdin, "write").mockReturnValue(true);
		const input = manualInput();
		const { readable } = createBridge(input.readable);
		const reader = readable.getReader();

		input.push(createBlock(0.5, 0, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));
		await tick();

		writeSpy.mockReturnValue(false);
		stdin.destroy();
		stdout.push(null);
		exit(0);

		input.push(createBlock(0.5, BLOCK_FRAMES, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));
		input.close();

		const end = served(await raceParked(reader.read()));

		expect(end.done).toBe(true);
		// After a clean exit the next block is dropped unwritten.
		expect(writeSpy).toHaveBeenCalledTimes(1);
	});

	it("never spawns from a _transform called once the stream's signal has aborted", async () => {
		const controller = new AbortController();
		const { stream } = createBridge(readableFrom([]), { signal: controller.signal });
		const block = createBlock(0.5, 0, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE });

		controller.abort(new Error("render failed"));

		const first = await stream._transform(block).next();

		expect(first.done).toBe(true);
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
	});

	it("never spawns from a _transform called once teardown has begun", async () => {
		const { stream } = createBridge(readableFrom([]));
		const block = createBlock(0.5, 0, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE });

		// The bases never call a hook after destroy(), so only a direct caller reaches this guard. Calling in the same
		// tick as destroy() reaches it before the stream's own signal aborts, which isolates the isDestroyed check.
		const destroying = stream.destroy();
		const first = await stream._transform(block).next();

		await destroying;

		expect(first.done).toBe(true);
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
	});

	it("errors with the signal when the child is killed, and does not kill it again", async () => {
		const { child, stdin, stdout, stderr, exit, kill } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		const { readable } = createBridge(readableFrom(inputBlocks(1)));
		const reader = readable.getReader();

		await tick();

		stderr.write(Buffer.from("Killed"));
		await tick();

		stdout.push(null);
		await tick();
		exit(null, "SIGKILL");

		await expect(reader.read()).rejects.toThrow("ffmpeg exited with signal SIGKILL: Killed");
		expect(kill).not.toHaveBeenCalled();
	});

	it("keeps listener counts flat across repeated parked passes", async () => {
		const { child, stdin, stdout } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(false);

		const { readable, stream } = createBridge(readableFrom(inputBlocks(2)));
		const signal = (stream as unknown as { readonly streamSignal: AbortSignal }).streamSignal;
		const counts = (): Array<number> => [
			stdin.listenerCount("drain"),
			stdin.listenerCount("close"),
			stdin.listenerCount("error"),
			child.listenerCount("exit"),
			getEventListeners(signal, "abort").length,
		];
		const reader = readable.getReader();

		stdout.push(pcmBytes(0.1, BLOCK_FRAMES));
		await reader.read();
		await tick();

		const parked = counts();

		// One drain wait serves the parked write across every pass.
		expect(stdin.listenerCount("drain")).toBe(1);

		for (let pass = 0; pass < 5; pass++) {
			stdout.push(pcmBytes(0.2, BLOCK_FRAMES));
			await reader.read();
			await tick();
		}

		expect(counts()).toEqual(parked);

		await reader.cancel();
	});

	it("resolves a cancel while _flush waits for stdout to end", async () => {
		const { child, stdin, kill } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		const endSpy = vi.spyOn(stdin, "end");
		const { readable } = createBridge(readableFrom(inputBlocks(1)));
		const reader = readable.getReader();

		await vi.waitFor(() => expect(endSpy).toHaveBeenCalled());
		await expect(reader.cancel()).resolves.toBeUndefined();
		expect(kill).toHaveBeenNthCalledWith(1, "SIGKILL");
	});

	it("sends SIGTERM first when the stream's own decode fails", async () => {
		const { child, stdin, stdout, kill } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(true);

		stdout.push(Buffer.from("usage: tool\n"));

		const stream = new CliStream(cli({ command: "tool", outputFormat: "wav" }), createTestStreamContext().context);

		stream._setup(createTestSetupContext());

		const reader = stream._pipe(readableFrom(inputBlocks(4))).getReader();

		await expect(reader.read()).rejects.toThrow('Not a WAV stream (first bytes "usag")');
		await stream.destroy();

		expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
	}, 10_000);

	it("ignores an EOF stdin error, which Windows reports for a closed pipe", async () => {
		const { child, stdin, stdout } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const writeSpy = vi.spyOn(stdin, "write").mockReturnValue(true);
		const input = manualInput();
		const { readable } = createBridge(input.readable);
		const reader = readable.getReader();

		input.push(createBlock(0.5, 0, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));
		await tick();

		stdin.emit("error", Object.assign(new Error("write EOF"), { code: "EOF" }));

		stdout.push(pcmBytes(0.5, BLOCK_FRAMES));

		// The child still runs, so a stored stdin error would throw on this block before writing it.
		input.push(createBlock(0.5, BLOCK_FRAMES, BLOCK_FRAMES, { channels: 1, sampleRate: SAMPLE_RATE }));

		expect((await reader.read()).value?.samples[0]?.[0]).toBeCloseTo(0.5, 5);
		expect(writeSpy).toHaveBeenCalledTimes(2);

		await reader.cancel();
	});

	it("never spawns once the render signal that _setup recorded has aborted", async () => {
		const controller = new AbortController();
		const { readable } = createBridge(readableFrom(inputBlocks(2)), { signal: controller.signal });

		controller.abort(new Error("render failed"));

		await expect(readable.getReader().read()).rejects.toThrow("render failed");
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
	});

	it("rejects promptly when the binary does not exist", async () => {
		const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");

		childProcessMocks.spawn.mockImplementation(spawn);

		const missing = join(tmpdir(), `missing-ffmpeg-${String(process.pid)}`, "ffmpeg");
		const { readable } = createBridge(readableFrom(inputBlocks(2)), { ffmpegPath: missing });

		await expect(drainBlocks(readable)).rejects.toThrow(/^ffmpeg failed to start: .*ENOENT/);
	}, 5000);

	it("refuses an empty ffmpegPath before spawning", async () => {
		const { readable } = createBridge(readableFrom(inputBlocks(2)), { ffmpegPath: "" });

		await expect(drainBlocks(readable)).rejects.toThrow("FFmpeg node has no command");
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
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
