import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect } from "vitest";
import {
	BlockBuffer,
	type Block,
	type LogPayload,
	type RenderEvents,
	type StreamSetupContext,
	type StreamContext,
} from "@buffered-audio/core";
import { vst3, Vst3Stream } from ".";
import { read } from "../../sources/read";
import { write } from "../../targets/write";
import { createTestWav } from "../../utils/test-wav";
import { processStreamingThroughVstHost, spawnVstHostReady, VstHostExitedBeforeReadyError } from "./utils/process";

// Stub binary mimics the real `vst-host` CLI shape (node as binary + stub via `extraArgs`);
// spawns a real subprocess exercising the full lifecycle — hence "integration", not "unit".
const stubBinary = fileURLToPath(new URL("./__fixtures__/stub-binary.mjs", import.meta.url));

// Crashes (exits before READY) for the first N spawns, then behaves like stubBinary; count tracked in a file.
const crashBinary = fileURLToPath(new URL("./__fixtures__/crash-then-ready.mjs", import.meta.url));

const temporaryRoots = new Set<string>();

afterEach(async () => {
	await Promise.all([...temporaryRoots].map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryRoots.clear();
});

const newCounterFile = async (): Promise<string> => {
	const directory = await mkdtemp(join(tmpdir(), "vst3-retry-"));

	temporaryRoots.add(directory);

	return join(directory, "count");
};
const readCount = async (path: string): Promise<number> => {
	try {
		return Number.parseInt(await readFile(path, "utf-8"), 10) || 0;
	} catch {
		return 0;
	}
};
const writeStagesFile = async (): Promise<string> => {
	const directory = await mkdtemp(join(tmpdir(), "vst3-stages-"));
	const path = join(directory, "stages.json");

	temporaryRoots.add(directory);

	await writeFile(path, JSON.stringify([{ pluginPath: "x" }]));

	return path;
};

const buildContext = (sampleRate: number, temporaryDirectory: string): StreamSetupContext => ({
	executionProviders: ["cpu"],
	memoryLimit: 64 * 1024 * 1024,
	temporaryDirectory,
	highWaterMark: 1,
	sourceSampleRate: sampleRate,
	sampleRate,
});

const renderContext = (): StreamContext => ({ events: new EventEmitter() as RenderEvents, nextStreamId: () => 0 });

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function settleWithin<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`${label} did not settle within ${milliseconds}ms`)),
					milliseconds,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function waitForPid(path: string, milliseconds = 5_000): Promise<number> {
	const deadline = Date.now() + milliseconds;

	for (;;) {
		try {
			return Number.parseInt(await readFile(path, "utf8"), 10);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}

		if (Date.now() >= deadline) throw new Error(`PID file was not written within ${milliseconds}ms`);

		await delay(20);
	}
}

function processIsAbsent(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return false;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;

		throw error;
	}
}

async function waitForProcessAbsence(pid: number, milliseconds = 5_000): Promise<void> {
	const deadline = Date.now() + milliseconds;

	while (!processIsAbsent(pid)) {
		if (Date.now() >= deadline) throw new Error(`Process ${pid} remained alive after ${milliseconds}ms`);

		await delay(20);
	}
}

async function currentProcessRenderDirectories(): Promise<Set<string>> {
	const root = join(tmpdir(), "buffered-audio");

	try {
		const entries = await readdir(root, { withFileTypes: true });
		const prefix = `render-${process.pid}-`;

		return new Set(
			entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)).map((entry) => entry.name),
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();

		throw error;
	}
}

// Drives the whole-file transform the way the framework does: feeds the channels through the stream's
// pipe (setup), reads the enqueued output blocks back, and concatenates them per channel for round-trip
// comparison. Reading to completion runs setup -> buffer-accumulate -> flush(transform) -> destroy — the
// same lifecycle a real render drives, so the stages-JSON file is written and live during transform.
const processWholeFile = async (
	stream: Vst3Stream,
	channels: Array<Float32Array>,
	sampleRate = 44100,
): Promise<Array<Float32Array>> => {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-render-"));
	const input = new ReadableStream<Block>({
		start: (controller) => {
			controller.enqueue({ samples: channels, offset: 0, sampleRate, bitDepth: 32 });
			controller.close();
		},
	});

	try {
		const output = await stream.setup(input, buildContext(sampleRate, temporaryDirectory));
		const reader = output.getReader();
		const blocks: Array<Block> = [];

		for (;;) {
			const { done, value } = await reader.read();

			if (done) break;

			blocks.push(value);
		}

		const channelCount = blocks[0]?.samples.length ?? 0;
		const totalFrames = blocks.reduce((sum, block) => sum + (block.samples[0]?.length ?? 0), 0);
		const result: Array<Float32Array> = [];

		for (let ch = 0; ch < channelCount; ch++) {
			const channelData = new Float32Array(totalFrames);
			let offset = 0;

			for (const block of blocks) {
				const source = block.samples[ch];

				if (source) channelData.set(source, offset);
				offset += block.samples[0]?.length ?? 0;
			}

			result.push(channelData);
		}

		return result;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
};

describe("Vst3Stream subprocess lifecycle", () => {
	it("spawns the stub binary, receives READY, processes the whole buffer, and tears down cleanly", async () => {
		const events = new EventEmitter() as RenderEvents;
		const logs: Array<LogPayload> = [];
		let monitorSampleCount = 0;

		events.on("log", (_identity, payload) => logs.push(payload));

		const stream = new Vst3Stream(
			vst3({
				vstHostPath: process.execPath,
				stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
				extraArgs: [stubBinary],
				monitorIntervalMs: 20,
				monitorSampler: async () => {
					monitorSampleCount += 1;

					if (monitorSampleCount === 3) throw new Error("test sample failure");

					return { cpuMs: monitorSampleCount * 100, pidCount: 1 };
				},
			}),
			{ events, nextStreamId: () => 0 },
		);

		const channels = 2;
		const frames = 8192;
		const samples: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) {
			const arr = new Float32Array(frames);

			for (let i = 0; i < frames; i++) arr[i] = Math.sin((i / frames) * Math.PI * 2 * (ch + 1));

			samples.push(arr);
		}

		const before: Array<Float32Array> = samples.map((channel) => Float32Array.from(channel));

		const after = await processWholeFile(stream, samples);

		expect(after.length).toBe(channels);
		expect(after[0]!.length).toBe(frames);

		for (let ch = 0; ch < channels; ch++) {
			const original = before[ch]!;
			const result = after[ch]!;

			for (let i = 0; i < frames; i++) {
				expect(result[i]).toBeCloseTo(original[i]!, 6);
			}
		}

		expect(logs.find((log) => log.message === "vst-host liveness")).toEqual(
			expect.objectContaining({
				data: expect.objectContaining({ state: expect.stringMatching(/^(active|idle)$/) }),
			}),
		);
		expect(logs.find((log) => log.message === "vst-host liveness sample failed")).toEqual(
			expect.objectContaining({
				level: "warn",
				data: { error: "Error: test sample failure" },
			}),
		);
		expect(logs.find((log) => log.message === "vst-host input")?.data).toEqual({
			framesDone: frames,
			framesTotal: frames,
			bytesDone: frames * channels * 4,
			bytesTotal: frames * channels * 4,
		});
		expect(logs.find((log) => log.message === "vst-host output")?.data).toEqual({
			framesDone: frames,
			framesTotal: frames,
			bytesDone: frames * channels * 4,
			bytesTotal: frames * channels * 4,
		});
	}, 30_000);

	it("preserves non-telemetry stderr and reports exact callback totals", async () => {
		const frames = 4096;
		const channelCount = 1;
		const samples = Float32Array.from({ length: frames }, (_, index) => Math.sin(index / 100));
		const buffer = new BlockBuffer();
		const stagesPath = await writeStagesFile();
		const inputProgress: Array<unknown> = [];
		const outputProgress: Array<unknown> = [];

		await buffer.write([samples], 48_000, 32);
		await buffer.flushWrites();

		try {
			const handle = await spawnVstHostReady(process.execPath, [
				stubBinary,
				"--stages-json",
				stagesPath,
				"--sample-rate",
				"48000",
				"--channels",
				"1",
			]);

			await processStreamingThroughVstHost(handle, buffer, {
				channelCount,
				sampleRate: 48_000,
				bitDepth: 32,
				onInputProgress: (progress) => inputProgress.push(progress),
				onOutputProgress: (progress) => outputProgress.push(progress),
			});

			expect(inputProgress.at(-1)).toEqual({
				framesDone: frames,
				framesTotal: frames,
				bytesDone: frames * 4,
				bytesTotal: frames * 4,
			});
			expect(outputProgress.at(-1)).toEqual({
				framesDone: frames,
				framesTotal: frames,
				bytesDone: frames * 4,
				bytesTotal: frames * 4,
			});
			expect(handle.getStderrTail()).toBe(
				"stub-binary: ordinary diagnostic\nstub-binary: incomplete final diagnostic",
			);
			expect(handle.getStderrTail()).not.toContain("VST_HOST_EVENT");

			await buffer.reset();
			const result = await buffer.read(frames);

			expect(result.samples[0]).toEqual(samples);
		} finally {
			await buffer.close();
		}
	}, 30_000);

	it("handles a non-block-aligned buffer", async () => {
		// Whole-file mode has no per-block alignment requirement; any positive frame count must round-trip.
		const stream = new Vst3Stream(
			vst3({
				vstHostPath: process.execPath,
				stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
				extraArgs: [stubBinary],
			}),
			renderContext(),
		);

		const frames = 1500;
		const samples: Array<Float32Array> = [Float32Array.from({ length: frames }, (_, i) => i / frames)];
		const before = Float32Array.from(samples[0]!);

		const after = await processWholeFile(stream, samples);

		expect(after[0]!.length).toBe(frames);

		for (let i = 0; i < frames; i++) {
			expect(after[0]![i]).toBeCloseTo(before[i]!, 6);
		}
	}, 30_000);
});

describe("Vst3Stream cancellation", () => {
	async function abortHangingRender(mode: "--hang-before-ready" | "--hang-after-ready"): Promise<void> {
		const fixtureDirectory = await mkdtemp(join(tmpdir(), "vst3-abort-render-"));
		const inputPath = join(fixtureDirectory, "input.wav");
		const outputPath = join(fixtureDirectory, "output.wav");
		const pidPath = join(fixtureDirectory, "host.pid");
		const beforeDirectories = await currentProcessRenderDirectories();
		const controller = new AbortController();
		const samples = Float32Array.from({ length: 1024 }, (_, index) => Math.sin(index / 100));

		await writeFile(inputPath, createTestWav(48_000, 1, [samples], "32f"));

		const source = read(inputPath);
		const transform = vst3({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/ignored-by-stub.vst3" }],
			extraArgs: [stubBinary, mode, "--pid-file", pidPath],
		});

		source.to(transform);
		transform.to(write(outputPath));

		const render = source.createRenderJob({ signal: controller.signal }).render();

		void render.catch(() => undefined);

		try {
			const pid = await waitForPid(pidPath);

			controller.abort();

			await expect(settleWithin(render, "aborted render")).rejects.toHaveProperty("name", "AbortError");
			await waitForProcessAbsence(pid);

			const afterDirectories = await currentProcessRenderDirectories();
			const retained = [...afterDirectories].filter((directory) => !beforeDirectories.has(directory));

			expect(retained).toEqual([]);
		} finally {
			controller.abort();
			await settleWithin(
				render.catch(() => undefined),
				"aborted render cleanup",
			).catch(() => undefined);
			await rm(fixtureDirectory, { recursive: true, force: true });
		}
	}

	it("aborts and settles a host hanging before READY", async () => {
		await abortHangingRender("--hang-before-ready");
	}, 30_000);

	it("aborts and settles a host hanging after READY", async () => {
		await abortHangingRender("--hang-after-ready");
	}, 30_000);

	it("destroys a stream while its ready host is active", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-destroy-active-"));
		const pidPath = join(temporaryDirectory, "host.pid");
		const stream = new Vst3Stream(
			vst3({
				vstHostPath: process.execPath,
				stages: [{ pluginPath: "/ignored-by-stub.vst3" }],
				extraArgs: [stubBinary, "--hang-after-ready", "--pid-file", pidPath],
			}),
			renderContext(),
		);
		const samples = Float32Array.from({ length: 1024 }, (_, index) => Math.sin(index / 100));
		const input = new ReadableStream<Block>({
			start(controller) {
				controller.enqueue({ samples: [samples], offset: 0, sampleRate: 48_000, bitDepth: 32 });
				controller.close();
			},
		});

		try {
			const output = await stream.setup(input, buildContext(48_000, temporaryDirectory));
			const reader = output.getReader();
			const reading = reader.read();

			void reading.catch(() => undefined);

			const pid = await waitForPid(pidPath);

			await settleWithin(stream.destroy(), "stream destruction");
			await waitForProcessAbsence(pid);
			await expect(settleWithin(reading, "active transform read")).rejects.toThrow();
		} finally {
			await settleWithin(stream.destroy(), "stream cleanup").catch(() => undefined);
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("Vst3Stream init-crash retry", () => {
	it("re-spawns past a non-deterministic init crash and processes cleanly", async () => {
		// Crashes (exit 3221225477 before READY) on the first 2 spawns, succeeds on the 3rd; retry is transparent.
		const counter = await newCounterFile();
		const stream = new Vst3Stream(
			vst3({
				vstHostPath: process.execPath,
				stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
				extraArgs: [crashBinary, "--crash-file", counter, "--crash-count", "2", "--crash-code", "3221225477"],
			}),
			renderContext(),
		);

		const frames = 2048;
		const samples: Array<Float32Array> = [Float32Array.from({ length: frames }, (_, i) => i / frames)];
		const before = Float32Array.from(samples[0]!);

		const after = await processWholeFile(stream, samples);

		expect(after[0]!.length).toBe(frames);

		for (let i = 0; i < frames; i++) {
			expect(after[0]![i]).toBeCloseTo(before[i]!, 6);
		}

		expect(await readCount(counter)).toBe(3); // 2 crashed spawns + 1 success
	}, 30_000);

	it("exhausts maxAttempts on a persistent crash and rejects with the typed error", async () => {
		const counter = await newCounterFile();
		const stagesPath = await writeStagesFile();
		const args = [
			crashBinary,
			"--crash-file",
			counter,
			"--crash-count",
			"10",
			"--crash-code",
			"3221225477",
			"--stages-json",
			stagesPath,
			"--sample-rate",
			"48000",
			"--channels",
			"1",
		];

		await expect(spawnVstHostReady(process.execPath, args, { maxAttempts: 3, backoffMs: 0 })).rejects.toBeInstanceOf(
			VstHostExitedBeforeReadyError,
		);

		expect(await readCount(counter)).toBe(3); // exactly maxAttempts spawns, no more
	}, 30_000);

	it("does not retry a deterministic wrapper error (exit code 2)", async () => {
		const counter = await newCounterFile();
		const stagesPath = await writeStagesFile();
		const args = [
			crashBinary,
			"--crash-file",
			counter,
			"--crash-count",
			"10",
			"--crash-code",
			"2",
			"--stages-json",
			stagesPath,
			"--sample-rate",
			"48000",
			"--channels",
			"1",
		];

		await expect(spawnVstHostReady(process.execPath, args, { maxAttempts: 5, backoffMs: 0 })).rejects.toBeInstanceOf(
			VstHostExitedBeforeReadyError,
		);

		expect(await readCount(counter)).toBe(1); // failed fast — single spawn, no retries
	}, 30_000);
});
