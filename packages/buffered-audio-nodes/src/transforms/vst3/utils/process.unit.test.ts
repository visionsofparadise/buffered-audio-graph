import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockBuffer } from "@buffered-audio/core";
import {
	DIAGNOSTIC_TAIL_BYTES,
	observeVstHostStderr,
	processStreamingThroughVstHost,
	spawnVstHostReady,
	terminateVstHost,
	writeStagesJson,
	type VstHostHandle,
} from "./process";

vi.mock("node:child_process", { spy: true });

interface FakeChildProcess extends EventEmitter {
	readonly stdin: PassThrough;
	readonly stdout: PassThrough;
	readonly stderr: PassThrough;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	readonly kill: ReturnType<typeof vi.fn>;
}

function createFakeChildProcess(): FakeChildProcess {
	const proc = new EventEmitter() as FakeChildProcess;

	Object.assign(proc, {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
	});

	Object.defineProperty(proc, "kill", {
		value: vi.fn(() => {
			if (proc.exitCode !== null || proc.signalCode !== null) return false;

			proc.signalCode = "SIGTERM";
			queueMicrotask(() => {
				proc.stdout.end();
				proc.stderr.end();
				proc.emit("close", null, "SIGTERM");
			});

			return true;
		}),
	});

	return proc;
}

function mockSpawn(proc: FakeChildProcess): void {
	vi.mocked(spawn).mockReturnValueOnce(proc as unknown as ChildProcess);
}

async function spawnReadyHandle(proc: FakeChildProcess): Promise<VstHostHandle> {
	mockSpawn(proc);

	const handlePromise = spawnVstHostReady("vst-host", []);

	proc.stdout.emit("data", Buffer.from("READY\n"));

	return handlePromise;
}

describe("writeStagesJson", () => {
	it("writes exact stage data under the supplied render directory", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-stages-test-"));
		const stages = [
			{ pluginPath: "first.vst3", pluginName: "First" },
			{ pluginPath: "second.vst3", presetPath: "voice.vstpreset" },
		];

		try {
			const path = await writeStagesJson(stages, temporaryDirectory);

			expect(dirname(path)).toBe(temporaryDirectory);
			expect(basename(path)).toMatch(/^vst3-stages-[\da-f-]+\.json$/);
			expect(await readFile(path, "utf8")).toBe(JSON.stringify(stages));
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
});

describe("observeVstHostStderr", () => {
	it("accumulates arbitrary stderr bytes", async () => {
		const stderr = new PassThrough();
		const getStderrTail = observeVstHostStderr(stderr);
		const ended = once(stderr, "end");

		stderr.write("ordinary ");
		stderr.write(Buffer.from("café\n"));
		stderr.end("incomplete final");
		stderr.resume();

		await ended;

		expect(getStderrTail()).toBe("ordinary café\nincomplete final");
	});

	it("retains the newest 64 KiB of diagnostic bytes", async () => {
		const stderr = new PassThrough();
		const getStderrTail = observeVstHostStderr(stderr);
		const ended = once(stderr, "end");
		const diagnostic = `old-prefix\n${"x".repeat(DIAGNOSTIC_TAIL_BYTES + 1024)}\n`;

		stderr.end(diagnostic);
		stderr.resume();

		await ended;

		const expected = Buffer.from(diagnostic)
			.subarray(Buffer.byteLength(diagnostic) - DIAGNOSTIC_TAIL_BYTES)
			.toString("utf8");

		expect(Buffer.byteLength(getStderrTail())).toBe(DIAGNOSTIC_TAIL_BYTES);
		expect(getStderrTail()).toBe(expected);
	});
});

describe("VST host settlement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("captures exit eagerly and terminates repeatedly with one kill", async () => {
		const proc = createFakeChildProcess();
		const handle = await spawnReadyHandle(proc);

		await Promise.all([terminateVstHost(handle), terminateVstHost(handle)]);

		expect(proc.kill).toHaveBeenCalledTimes(1);
		await expect(handle.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
	});

	it("does not kill an already exited host", async () => {
		const proc = createFakeChildProcess();
		const handle = await spawnReadyHandle(proc);

		proc.exitCode = 0;
		proc.stdout.end();
		proc.stderr.end();
		proc.emit("close", 0, null);

		await terminateVstHost(handle);

		expect(proc.kill).not.toHaveBeenCalled();
		await expect(handle.exited).resolves.toEqual({ code: 0, signal: null });
	});

	it("does not spawn for an already aborted signal", async () => {
		const controller = new AbortController();

		controller.abort();

		await expect(spawnVstHostReady("vst-host", [], { signal: controller.signal })).rejects.toHaveProperty(
			"name",
			"AbortError",
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("terminates an aborted readiness attempt without retry or retained listener", async () => {
		const proc = createFakeChildProcess();
		const controller = new AbortController();
		const onRetry = vi.fn();

		mockSpawn(proc);

		const handlePromise = spawnVstHostReady("vst-host", [], {
			backoffMs: 0,
			maxAttempts: 5,
			onRetry,
			signal: controller.signal,
		});

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

		controller.abort();

		await expect(handlePromise).rejects.toHaveProperty("name", "AbortError");
		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("kills before transfer when processing starts already aborted", async () => {
		const proc = createFakeChildProcess();
		const handle = await spawnReadyHandle(proc);
		const controller = new AbortController();
		const reset = vi.fn();
		const buffer = { frames: 1, reset } as unknown as BlockBuffer;

		controller.abort();

		await expect(
			processStreamingThroughVstHost(handle, buffer, {
				channelCount: 1,
				sampleRate: 48_000,
				signal: controller.signal,
			}),
		).rejects.toHaveProperty("name", "AbortError");
		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(reset).not.toHaveBeenCalled();
		await terminateVstHost(handle);
	});

	it("removes processing listeners when an output write fails", async () => {
		const proc = createFakeChildProcess();
		const handle = await spawnReadyHandle(proc);
		const controller = new AbortController();
		const outputFailure = new Error("output write failed");
		const samples = Float32Array.of(0.25);
		const reset = vi.fn().mockResolvedValue(undefined);
		const read = vi.fn().mockResolvedValue({
			bitDepth: 32,
			offset: 0,
			sampleRate: 48_000,
			samples: [samples],
		});
		const write = vi.fn().mockRejectedValue(outputFailure);
		const flushWrites = vi.fn();
		const buffer = { frames: 1, reset, read, write, flushWrites } as unknown as BlockBuffer;

		const processing = processStreamingThroughVstHost(handle, buffer, {
			channelCount: 1,
			sampleRate: 48_000,
			signal: controller.signal,
		});

		setTimeout(() => {
			proc.stdout.emit("data", Buffer.from(samples.buffer));
			proc.stdout.emit("end");
			proc.exitCode = 0;
			proc.emit("close", 0, null);
		}, 0);

		await expect(processing).rejects.toBe(outputFailure);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(proc.stdout.listenerCount("data")).toBe(0);
		expect(proc.stdout.listenerCount("end")).toBe(0);
		expect(flushWrites).not.toHaveBeenCalled();
	});
});
