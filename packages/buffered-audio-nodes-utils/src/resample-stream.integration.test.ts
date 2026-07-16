import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResampleStream } from "./resample-stream";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: childProcessMocks.spawn,
}));

function createMockChild(): {
	readonly child: EventEmitter;
	readonly stdin: PassThrough;
	readonly kill: ReturnType<typeof vi.fn>;
	readonly stdout: PassThrough;
} {
	const child = new EventEmitter();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let exitCode: number | null = null;
	let killed = false;
	const kill = vi.fn(() => {
		killed = true;
		queueMicrotask(() => {
			exitCode = 0;
			child.emit("exit", 0, null);
		});

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

	return { child, stdin, kill, stdout };
}

afterEach(() => {
	childProcessMocks.spawn.mockReset();
});

describe("ResampleStream", () => {
	it("pauses at the high-water mark and resumes at the low-water mark", async () => {
		const { child, stdout } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const pause = vi.spyOn(stdout, "pause");
		const resume = vi.spyOn(stdout, "resume");
		const channels = 2;
		const bytesPerFrame = channels * Float32Array.BYTES_PER_ELEMENT;
		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels,
		});
		resume.mockClear();

		stdout.emit("data", Buffer.alloc(65_536 * bytesPerFrame));

		expect(pause).toHaveBeenCalledTimes(1);
		expect(resume).not.toHaveBeenCalled();

		stdout.emit("data", Buffer.alloc(bytesPerFrame));

		expect(pause).toHaveBeenCalledTimes(1);

		await stream.read(32_768);

		expect(pause).toHaveBeenCalledTimes(1);
		expect(resume).not.toHaveBeenCalled();

		await stream.read(1);

		expect(resume).toHaveBeenCalledTimes(1);

		await stream.close();
	});

	it("terminates the child and rejects a pending read on close", async () => {
		const { child, kill } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		const pendingRead = expect(stream.read(1)).rejects.toThrow("ResampleStream: close while read pending");

		await stream.close();
		await pendingRead;

		expect(kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("rejects a pending read when the child errors without ending stdout", async () => {
		const { child } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);

		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		let settled = false;
		let readError: unknown;
		const pendingRead = stream.read(1).catch((error: unknown) => {
			settled = true;
			readError = error;
		});

		try {
			child.emit("error", new Error("ffmpeg crashed"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(settled).toBe(true);
			expect(readError).toEqual(new Error("ffmpeg crashed"));
		} finally {
			await stream.close();
			await pendingRead;
		}
	});

	it("serializes shared drain waiters when the first resumed write backpressures again", async () => {
		const { child, stdin } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		const write = vi.spyOn(stdin, "write")
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);
		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		const writes = [
			stream.write([new Float32Array([1])]),
			stream.write([new Float32Array([2])]),
			stream.write([new Float32Array([3])]),
		];

		expect(write).toHaveBeenCalledTimes(1);
		expect(stdin.listenerCount("drain")).toBe(1);

		stdin.emit("drain");
		await Promise.resolve();

		expect(write).toHaveBeenCalledTimes(2);
		expect(stdin.listenerCount("drain")).toBe(1);

		stdin.emit("drain");
		await Promise.all(writes);

		expect(write).toHaveBeenCalledTimes(3);
		expect(write).toHaveBeenNthCalledWith(1, Buffer.from(new Float32Array([1]).buffer));
		expect(write).toHaveBeenNthCalledWith(2, Buffer.from(new Float32Array([2]).buffer));
		expect(write).toHaveBeenNthCalledWith(3, Buffer.from(new Float32Array([3]).buffer));
		expect(stdin.listenerCount("drain")).toBe(0);

		await stream.close();
	});

	it("revalidates queued writes when close follows a successful drain", async () => {
		const { child, stdin } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		const write = vi.spyOn(stdin, "write").mockReturnValueOnce(false).mockReturnValueOnce(true);
		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		const firstWrite = expect(stream.write([new Float32Array([1])])).rejects.toThrow("ResampleStream: write after close");
		const queuedWrite = expect(stream.write([new Float32Array([2])])).rejects.toThrow("ResampleStream: write after close");

		stdin.emit("drain");
		const close = stream.close();

		await Promise.all([firstWrite, queuedWrite, close]);

		expect(write).toHaveBeenCalledTimes(1);
		expect(stdin.listenerCount("drain")).toBe(0);
	});

	it("revalidates queued writes when clean exit follows a successful drain", async () => {
		const { child, stdin } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		const write = vi.spyOn(stdin, "write").mockReturnValueOnce(false).mockReturnValueOnce(true);
		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		const firstWrite = expect(stream.write([new Float32Array([1])])).rejects.toThrow(
			"ResampleStream: write after ffmpeg exit",
		);
		const queuedWrite = expect(stream.write([new Float32Array([2])])).rejects.toThrow(
			"ResampleStream: write after ffmpeg exit",
		);

		stdin.emit("drain");
		child.emit("exit", 0, null);

		await Promise.all([firstWrite, queuedWrite]);

		expect(write).toHaveBeenCalledTimes(1);
		expect(stdin.listenerCount("drain")).toBe(0);

		await stream.close();
	});

	it("rejects a queued write when end resumes first after a shared drain", async () => {
		const { child, stdin } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		const write = vi.spyOn(stdin, "write").mockReturnValueOnce(false).mockReturnValueOnce(true);
		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		const firstWrite = stream.write([new Float32Array([1])]);
		const end = stream.end();
		const queuedWrite = expect(stream.write([new Float32Array([2])])).rejects.toThrow("ResampleStream: write after end");

		stdin.emit("drain");

		await Promise.all([firstWrite, end, queuedWrite]);

		expect(write).toHaveBeenCalledTimes(1);
		expect(stdin.writableEnded).toBe(true);
		expect(stdin.listenerCount("drain")).toBe(0);

		await stream.close();
	});

	it("rejects a backpressured write when the child errors", async () => {
		const { child, stdin } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(false);

		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		const pendingWrite = expect(stream.write([new Float32Array([0])])).rejects.toThrow("ffmpeg crashed");

		child.emit("error", new Error("ffmpeg crashed"));

		await pendingWrite;
		await stream.close();
	});

	it("rejects a backpressured write when the child exits before drain", async () => {
		const { child, stdin } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(false);

		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		const pendingWrite = expect(stream.write([new Float32Array([0])])).rejects.toThrow(
			"ResampleStream: ffmpeg exited while waiting for stdin drain",
		);

		child.emit("exit", 0, null);

		await pendingWrite;
		await stream.close();
	});

	it("rejects a backpressured write when the stream closes", async () => {
		const { child, stdin, kill } = createMockChild();

		childProcessMocks.spawn.mockReturnValue(child);
		vi.spyOn(stdin, "write").mockReturnValue(false);

		const stream = new ResampleStream("ffmpeg", {
			sourceSampleRate: 48_000,
			targetSampleRate: 44_100,
			channels: 1,
		});
		const pendingWrite = expect(stream.write([new Float32Array([0])])).rejects.toThrow(
			"ResampleStream: close while write pending",
		);

		await stream.close();
		await pendingWrite;

		expect(kill).toHaveBeenCalledWith("SIGTERM");
	});
});
