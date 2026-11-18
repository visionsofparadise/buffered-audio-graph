import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestSetupContext, createTestStreamContext } from "@buffered-audio/core/testing";
import { readFfmpeg, ReadFfmpegStream } from ".";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: childProcessMocks.spawn,
}));

function createProbeProcess(): { readonly process: EventEmitter; readonly finish: () => void } {
	const probeProcess = new EventEmitter();
	const stdout = new PassThrough();
	const stderr = new PassThrough();

	Object.defineProperties(probeProcess, {
		stdout: { value: stdout },
		stderr: { value: stderr },
		exitCode: { value: null, writable: true },
		signalCode: { value: null },
		kill: { value: vi.fn() },
	});

	return {
		process: probeProcess,
		finish: () => {
			stdout.write(JSON.stringify({ streams: [{ sample_rate: "44100", channels: 1, duration: "1" }] }));
			setImmediate(() => probeProcess.emit("close", 0));
		},
	};
}

function createSilentFfmpegProcess(): { readonly process: EventEmitter; readonly kill: ReturnType<typeof vi.fn> } {
	const ffmpegProcess = new EventEmitter();
	const stdout = new PassThrough();
	let exitCode: number | null = null;
	const kill = vi.fn(() => {
		queueMicrotask(() => {
			exitCode = 1;
			stdout.end();
			ffmpegProcess.emit("exit", 1, null);
			ffmpegProcess.emit("close", 1, null);
		});

		return true;
	});

	Object.defineProperties(ffmpegProcess, {
		stdout: { value: stdout },
		stderr: { value: new PassThrough() },
		exitCode: { get: () => exitCode },
		signalCode: { value: null },
		killed: { get: () => kill.mock.calls.length > 0 },
		kill: { value: kill },
	});

	return { process: ffmpegProcess, kill };
}

function createStream(): ReadFfmpegStream {
	const node = readFfmpeg("input.wav", { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });

	return new ReadFfmpegStream(node, createTestStreamContext().context);
}

async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`did not settle within ${String(milliseconds)}ms`)),
					milliseconds,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

afterEach(() => {
	childProcessMocks.spawn.mockReset();
});

describe("ReadFfmpegStream teardown", () => {
	it("errors instead of spawning ffmpeg when the stream is destroyed while ffprobe runs", async () => {
		const probe = createProbeProcess();

		childProcessMocks.spawn.mockReturnValueOnce(probe.process);

		const stream = createStream();
		const reader = (await stream.setup(createTestSetupContext())).getReader();
		const reading = reader.read();

		reading.catch(() => undefined);

		await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1));

		const destroying = stream.destroy();

		probe.finish();
		await destroying;

		await expect(reading).rejects.toMatchObject({ name: "AbortError" });
		expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
	});

	it("finishes a teardown promptly and kills ffmpeg while its stdout stays silent", async () => {
		const probe = createProbeProcess();
		const ffmpeg = createSilentFfmpegProcess();

		childProcessMocks.spawn.mockReturnValueOnce(probe.process).mockReturnValueOnce(ffmpeg.process);

		const stream = createStream();

		await stream.setup(createTestSetupContext());
		await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1));

		probe.finish();

		await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2));
		await settleWithin(stream.destroy(), 1000);

		expect(ffmpeg.kill).toHaveBeenCalled();
	});
});
