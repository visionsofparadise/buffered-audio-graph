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

	Object.defineProperties(probeProcess, { stdout: { value: stdout }, stderr: { value: stderr } });

	return {
		process: probeProcess,
		finish: () => {
			stdout.write(JSON.stringify({ streams: [{ sample_rate: "44100", channels: 1, duration: "1" }] }));
			setImmediate(() => probeProcess.emit("close", 0));
		},
	};
}

afterEach(() => {
	childProcessMocks.spawn.mockReset();
});

describe("ReadFfmpegStream teardown", () => {
	it("does not spawn ffmpeg when the stream is destroyed while ffprobe runs", async () => {
		const probe = createProbeProcess();

		childProcessMocks.spawn.mockReturnValueOnce(probe.process);

		const node = readFfmpeg("input.wav", { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
		const stream = new ReadFfmpegStream(node, createTestStreamContext().context);

		await stream.setup(createTestSetupContext());
		await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1));

		const destroying = stream.destroy();

		probe.finish();
		await destroying;

		expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
	});
});
