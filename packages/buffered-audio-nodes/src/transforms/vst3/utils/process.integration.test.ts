import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockBuffer, ChildOutputHeldError } from "@buffered-audio/core";
import {
	processStreamingThroughVstHost,
	spawnVstHostReady,
	terminateVstHost,
	writeStagesJson,
	type VstHostHandle,
} from "./process";

vi.mock("node:child_process", { spy: true });

const teardownStub = fileURLToPath(new URL("../__fixtures__/teardown-stub.mjs", import.meta.url));

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

interface FakeChildProcess extends EventEmitter {
	readonly stdin: PassThrough;
	readonly stdout: PassThrough;
	readonly stderr: PassThrough;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	readonly kill: ReturnType<typeof vi.fn>;
	readonly exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

function createFakeChildProcess(): FakeChildProcess {
	const proc = new EventEmitter() as FakeChildProcess;
	let exitCode: number | null = null;
	let signalCode: NodeJS.Signals | null = null;
	const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
		exitCode = code;
		signalCode = signal;
		proc.emit("exit", code, signal);
		proc.emit("close", code, signal);
	};

	Object.defineProperties(proc, {
		stdin: { value: new PassThrough() },
		stdout: { value: new PassThrough() },
		stderr: { value: new PassThrough() },
		exitCode: { get: () => exitCode },
		signalCode: { get: () => signalCode },
		exit: { value: exit },
		kill: {
			value: vi.fn(() => {
				if (exitCode !== null || signalCode !== null) return false;

				signalCode = "SIGTERM";
				queueMicrotask(() => {
					proc.stdout.end();
					proc.stderr.end();
					exit(null, "SIGTERM");
				});

				return true;
			}),
		},
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

describe("VST host settlement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("captures exit eagerly and terminates repeatedly with one kill", async () => {
		const proc = createFakeChildProcess();
		const handle = await spawnReadyHandle(proc);

		await Promise.all([terminateVstHost(handle), terminateVstHost(handle)]);

		expect(proc.kill).toHaveBeenCalledTimes(1);
		await expect(handle.handle.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
	});

	it("does not kill an already exited host", async () => {
		const proc = createFakeChildProcess();
		const handle = await spawnReadyHandle(proc);

		proc.stdout.end();
		proc.stderr.end();
		proc.exit(0, null);

		await terminateVstHost(handle);

		expect(proc.kill).not.toHaveBeenCalled();
		await expect(handle.handle.exited).resolves.toEqual({ code: 0, signal: null });
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
			processStreamingThroughVstHost(handle, buffer, {} as BlockBuffer, {
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
		const input = { frames: 1, reset, read } as unknown as BlockBuffer;
		const output = { write, flushWrites } as unknown as BlockBuffer;

		const processing = processStreamingThroughVstHost(handle, input, output, {
			channelCount: 1,
			sampleRate: 48_000,
			signal: controller.signal,
		});

		setTimeout(() => {
			proc.stdout.emit("data", Buffer.from(samples.buffer));
			proc.stdout.emit("end");
			proc.exit(0, null);
		}, 0);

		await expect(processing).rejects.toBe(outputFailure);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(proc.stdout.listenerCount("data")).toBe(0);
		expect(proc.stdout.listenerCount("end")).toBe(0);
		expect(flushWrites).not.toHaveBeenCalled();
	});

	it("keeps the READY chunk's tail and the output buffered in paused stdout, in order", async () => {
		const frames = 2048;
		const directory = await mkdtemp(join(tmpdir(), "vst3-paused-"));
		const input = new BlockBuffer(directory);
		const output = new BlockBuffer(directory);
		const ramp = Float32Array.from({ length: frames }, (_, index) => index / frames);
		const hostOutput = Buffer.from(ramp.buffer);
		const proc = createFakeChildProcess();

		try {
			await input.write([new Float32Array(frames)], 48_000, 32);
			await input.flushWrites();

			mockSpawn(proc);

			const ready = spawnVstHostReady("vst-host", []);

			proc.stdout.write(Buffer.concat([Buffer.from("READY\n"), hostOutput.subarray(0, 4)]));

			const handle = await ready;

			expect(proc.stdout.isPaused()).toBe(true);
			expect(handle.readyTail()).toEqual(hostOutput.subarray(0, 4));

			proc.stdout.write(hostOutput.subarray(4));
			proc.stdout.end();
			proc.exit(0, null);

			const processing = processStreamingThroughVstHost(handle, input, output, {
				channelCount: 1,
				sampleRate: 48_000,
				bitDepth: 32,
			});

			await processing;
			await output.reset();

			const result = await output.read(frames);

			expect(result.samples[0]).toEqual(ramp);
		} finally {
			await input.close();
			await output.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("vst-host spawn failures", () => {
	it("reports a missing vst-host as a failure to start and never retries it", async () => {
		const onRetry = vi.fn();

		await expect(
			spawnVstHostReady(join(tmpdir(), "missing-vst-host"), [], { backoffMs: 0, maxAttempts: 5, onRetry }),
		).rejects.toThrow(/vst-host failed to start/);
		expect(onRetry).not.toHaveBeenCalled();
	});
});

describe("vst-host stdout held after a clean exit", () => {
	const FRAMES = 2048;
	const directories = new Set<string>();

	afterEach(async () => {
		for (const directory of directories) {
			const holderPid = await readFile(join(directory, "holder.pid"), "utf8").then(
				(text) => Number.parseInt(text, 10),
				() => undefined,
			);

			if (holderPid !== undefined) await waitForProcessAbsence(holderPid, 10_000);

			await rm(directory, { recursive: true, force: true });
		}

		directories.clear();
	});

	async function waitForProcessAbsence(pid: number, milliseconds: number): Promise<void> {
		const deadline = Date.now() + milliseconds;

		for (;;) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ESRCH") return;

				throw error;
			}

			if (Date.now() >= deadline) throw new Error(`Process ${pid} remained alive after ${milliseconds}ms`);

			await delay(50);
		}
	}

	interface HeldPass {
		readonly outcome: Promise<unknown>;
		readonly host: VstHostHandle;
		readonly buffer: BlockBuffer;
		readonly output: BlockBuffer;
		readonly input: Float32Array;
		readonly startedAt: number;
		readonly writtenFrames: () => number;
	}

	async function startHeldPass(
		flags: ReadonlyArray<string>,
		onOutputHeld: (error: ChildOutputHeldError) => void,
	): Promise<HeldPass> {
		const directory = await mkdtemp(join(tmpdir(), "vst3-held-"));

		directories.add(directory);

		const buffer = new BlockBuffer(directory);
		const input = Float32Array.from({ length: FRAMES }, (_, index) => Math.sin(index / 100));

		await buffer.write([input], 48_000, 32);
		await buffer.flushWrites();

		const host = await spawnVstHostReady(process.execPath, [
			teardownStub,
			"--mode",
			"echo-then-exit-holding-stdio",
			"--holder-dir",
			directory,
			...flags,
		]);
		const output = new BlockBuffer(directory);
		const write = output.write.bind(output);
		let writtenFrames = 0;

		vi.spyOn(output, "write").mockImplementation(async (samples, sampleRate, bitDepth) => {
			writtenFrames += samples[0]?.length ?? 0;
			await write(samples, sampleRate, bitDepth);
		});

		const startedAt = performance.now();
		const outcome = processStreamingThroughVstHost(host, buffer, output, {
			channelCount: 1,
			sampleRate: 48_000,
			bitDepth: 32,
			onOutputHeld,
		}).then(
			() => undefined,
			(error: unknown) => error,
		);

		return { outcome, host, buffer, output, input, startedAt, writtenFrames: () => writtenFrames };
	}

	async function finish(pass: HeldPass): Promise<void> {
		await terminateVstHost(pass.host);
		await pass.buffer.close();
		await pass.output.close();
	}

	it("keeps exactly complete output and reports the held stdout", async () => {
		const onOutputHeld = vi.fn();
		const pass = await startHeldPass([], onOutputHeld);

		try {
			expect(await pass.outcome).toBeUndefined();
			expect(onOutputHeld).toHaveBeenCalledOnce();
			expect(onOutputHeld.mock.calls[0]?.[0]).toBeInstanceOf(ChildOutputHeldError);

			await pass.output.reset();
			const result = await pass.output.read(FRAMES);

			expect(result.samples[0]).toEqual(pass.input);
		} finally {
			await finish(pass);
		}
	}, 10_000);

	it("rejects short output whose stdout stays open with the held-stdout error", async () => {
		const onOutputHeld = vi.fn();
		const pass = await startHeldPass(["--short-output"], onOutputHeld);

		try {
			const error = await pass.outcome;

			expect(performance.now() - pass.startedAt).toBeLessThan(5_000);
			expect(error).toBeInstanceOf(ChildOutputHeldError);
			expect((error as Error).message).toMatch(/vst-host exited, but its stdout stayed open for 2000 ms/);
			expect(onOutputHeld).not.toHaveBeenCalled();
		} finally {
			await finish(pass);
		}
	}, 10_000);

	it("reports a failed exit rather than the held stdout", async () => {
		const onOutputHeld = vi.fn();
		const pass = await startHeldPass(["--exit-code", "3"], onOutputHeld);

		try {
			const error = await pass.outcome;

			expect(performance.now() - pass.startedAt).toBeLessThan(5_000);
			expect((error as Error).message).toMatch(/vst-host exited 3: failed/);
			expect(onOutputHeld).not.toHaveBeenCalled();
		} finally {
			await finish(pass);
		}
	}, 10_000);

	it("appends nothing a writing holder sends after the deadline and waits no longer for the close", async () => {
		const onOutputHeld = vi.fn();
		const pass = await startHeldPass(["--holder-writes", "--short-output"], onOutputHeld);

		try {
			const error = await pass.outcome;
			const elapsed = performance.now() - pass.startedAt;
			const framesAtRejection = pass.writtenFrames();

			expect(error).toBeInstanceOf(ChildOutputHeldError);
			expect(elapsed).toBeLessThan(3_000);
			expect(pass.host.handle.stdout?.listenerCount("data")).toBe(0);

			await delay(1_000);

			expect(pass.writtenFrames()).toBe(framesAtRejection);
			expect(onOutputHeld).not.toHaveBeenCalled();
		} finally {
			await finish(pass);
		}
	}, 15_000);
});
