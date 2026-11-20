import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { BlockBuffer, isAbortReason, type Block } from "@buffered-audio/core";
import {
	createTestSetupContext,
	createTestStreamContext,
	drainBlocks,
	readableFrom,
} from "@buffered-audio/core/testing";
import { read } from "../../sources/read";
import { write } from "../../targets/write";
import { createTestWav } from "../../utils/test-wav";
import { schema, vst3, Vst3Node, Vst3PassthroughStream, Vst3Stream } from ".";
import { processStreamingThroughVstHost, spawnVstHostReady } from "./utils/process";

describe("Vst3Node schema", () => {
	it("accepts a valid configuration", () => {
		const result = schema.parse({
			vstHostPath: "/path/to/vst-host",
			stages: [
				{ pluginPath: "/path/to/plugin.vst3", presetPath: "/path/to/preset.vstpreset" },
				{ pluginPath: "/path/to/shell.vst3", pluginName: "DeEsser Mono" },
			],
			bypass: false,
		});

		expect(result.vstHostPath).toBe("/path/to/vst-host");
		expect(result.stages).toHaveLength(2);
		expect(result.stages[0]!.pluginPath).toBe("/path/to/plugin.vst3");
		expect(result.stages[0]!.presetPath).toBe("/path/to/preset.vstpreset");
		expect(result.stages[1]!.pluginName).toBe("DeEsser Mono");
		expect(result.bypass).toBe(false);
	});

	it("applies defaults for optional fields", () => {
		const result = schema.parse({ stages: [{ pluginPath: "/path/to/plugin.vst3" }] });

		expect(result.vstHostPath).toBe("");
		expect(result.bypass).toBe(false);
		expect(result.stages[0]!.presetPath).toBeUndefined();
		expect(result.stages[0]!.pluginName).toBeUndefined();
	});

	it("rejects missing stages", () => {
		const result = schema.safeParse({});

		expect(result.success).toBe(false);
	});

	it("rejects an empty stages array", () => {
		const result = schema.safeParse({ stages: [] });

		expect(result.success).toBe(false);
	});

	it("rejects a stage missing pluginPath", () => {
		const result = schema.safeParse({ stages: [{ presetPath: "/p" }] });

		expect(result.success).toBe(false);
	});

	it("rejects a non-string presetPath", () => {
		const result = schema.safeParse({ stages: [{ pluginPath: "/p", presetPath: 42 }] });

		expect(result.success).toBe(false);
	});

	it("rejects a non-boolean bypass", () => {
		const result = schema.safeParse({ stages: [{ pluginPath: "/p" }], bypass: "yes" });

		expect(result.success).toBe(false);
	});
});

describe("Vst3Node", () => {
	it("exposes the expected static metadata", () => {
		expect(Vst3Node.nodeName).toBe("VST3");
		expect(Vst3Node.description).toMatch(/VST3 effect plugins/);
	});

	it("uses Vst3Stream as its stream class", () => {
		expect(Vst3Node.Stream).toBe(Vst3Stream);
	});
});

describe("Vst3PassthroughStream", () => {
	it("passes audio through unchanged sample-for-sample without spawning a subprocess", async () => {
		// bypass is now resolved by the executor (the node is skipped); the passthrough stream is the
		// unbuffered identity used where a passthrough is wired directly. The missing paths would make
		// any spawn fail loudly, proving no subprocess is spawned.
		const node = vst3({
			vstHostPath: "/missing/binary",
			stages: [{ pluginPath: "/missing/plugin.vst3" }],
			bypass: true,
		});
		const stream = new Vst3PassthroughStream(node, createTestStreamContext().context);

		const samples = [Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.5]), Float32Array.from([-0.1, 0.2, -0.3, 0.4, -0.5])];
		const before: Array<Float32Array> = samples.map((channel) => Float32Array.from(channel));

		const input = readableFrom([{ samples, offset: 0, sampleRate: 44100, bitDepth: 32 }]);

		const output = await stream.setup(
			input,
			createTestSetupContext({ memoryLimit: 64 * 1024 * 1024, highWaterMark: 1 }),
		);
		const blocks = await drainBlocks(output);

		expect(blocks).toHaveLength(1);

		const result = blocks[0]!;

		for (let ch = 0; ch < samples.length; ch++) {
			const original = before[ch]!;
			const resultChannel = result.samples[ch]!;

			expect(resultChannel.length).toBe(original.length);

			for (let i = 0; i < original.length; i++) {
				expect(resultChannel[i]).toBe(original[i]);
			}
		}
	});
});

const stubBinary = fileURLToPath(new URL("./__fixtures__/stub-binary.mjs", import.meta.url));
const teardownStub = fileURLToPath(new URL("./__fixtures__/teardown-stub.mjs", import.meta.url));
const crashBinary = fileURLToPath(new URL("./__fixtures__/crash-then-ready.mjs", import.meta.url));

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

async function waitForProcessAbsence(pid: number, milliseconds = 5_000): Promise<void> {
	const deadline = Date.now() + milliseconds;

	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return;

			throw error;
		}

		if (Date.now() >= deadline) throw new Error(`Process ${pid} remained alive after ${milliseconds}ms`);

		await delay(20);
	}
}

function hangingHostStream(pidPath: string): Vst3Stream {
	return new Vst3Stream(
		vst3({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/ignored-by-stub.vst3" }],
			extraArgs: [stubBinary, "--hang-after-ready", "--pid-file", pidPath],
		}),
		createTestStreamContext().context,
	);
}

function singleBlock(frames: number): ReadableStream<Block> {
	const samples = Float32Array.from({ length: frames }, (_, index) => Math.sin(index / 100));

	return readableFrom([{ samples: [samples], offset: 0, sampleRate: 48_000, bitDepth: 32 }]);
}

describe("Vst3Stream cancellation", () => {
	it("wakes a host hanging after READY when the output is cancelled", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-cancel-active-"));
		const pidPath = join(temporaryDirectory, "host.pid");
		const stream = hangingHostStream(pidPath);

		try {
			const output = await stream.setup(
				singleBlock(1024),
				createTestSetupContext({ temporaryDirectory, sampleRate: 48_000, highWaterMark: 1 }),
			);
			const reader = output.getReader();

			reader.read().catch(() => undefined);

			const pid = await waitForPid(pidPath);

			await settleWithin(reader.cancel(), "downstream cancel");
			await waitForProcessAbsence(pid);
		} finally {
			await settleWithin(stream.destroy(), "stream cleanup").catch(() => undefined);
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 30_000);

	it("surfaces the abort, not the closed pipe, when a render aborts while stdin waits to drain", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-abort-drain-"));
		const pidPath = join(temporaryDirectory, "host.pid");
		const stream = hangingHostStream(pidPath);
		const controller = new AbortController();

		try {
			// Far more than a pipe buffer, so the write parks on drain once the stub stops reading.
			const output = await stream.setup(
				singleBlock(2_000_000),
				createTestSetupContext({
					temporaryDirectory,
					sampleRate: 48_000,
					highWaterMark: 1,
					signal: controller.signal,
				}),
			);
			const reading = output.getReader().read();

			reading.catch(() => undefined);

			await waitForPid(pidPath);

			controller.abort();

			const error = await settleWithin(reading, "aborted read").then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(isAbortReason(error, controller.signal)).toBe(true);
		} finally {
			await settleWithin(stream.destroy(), "stream cleanup").catch(() => undefined);
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("processStreamingThroughVstHost settling", () => {
	async function streamWithSlowSecondRead(
		temporaryDirectory: string,
		duringRead: (controller: AbortController, handle: Awaited<ReturnType<typeof spawnVstHostReady>>) => Promise<void>,
	): Promise<unknown> {
		const stagesPath = join(temporaryDirectory, "stages.json");

		await writeFile(stagesPath, JSON.stringify([{ pluginPath: "x" }]));

		const frames = 4 * 48_000;
		const buffer = new BlockBuffer(temporaryDirectory);

		await buffer.write([Float32Array.from({ length: frames }, (_, index) => Math.sin(index / 100))], 48_000, 32);
		await buffer.flushWrites();

		const handle = await spawnVstHostReady(process.execPath, [
			stubBinary,
			"--stages-json",
			stagesPath,
			"--sample-rate",
			"48000",
			"--channels",
			"1",
		]);
		const read = buffer.read.bind(buffer);
		let reads = 0;
		let enteredSecondRead: (() => void) | undefined;
		const secondRead = new Promise<void>((resolve) => {
			enteredSecondRead = resolve;
		});

		vi.spyOn(buffer, "read").mockImplementation(async (count) => {
			reads += 1;

			if (reads === 2) {
				enteredSecondRead?.();
				await delay(500);
			}

			return read(count);
		});

		const controller = new AbortController();
		const output = new BlockBuffer(temporaryDirectory);
		const processing = processStreamingThroughVstHost(handle, buffer, output, {
			channelCount: 1,
			sampleRate: 48_000,
			bitDepth: 32,
			signal: controller.signal,
		});

		processing.catch(() => undefined);

		try {
			await secondRead;
			await duringRead(controller, handle);

			return await settleWithin(processing, "streaming pass").then(
				() => undefined,
				(reason: unknown) => reason,
			);
		} finally {
			handle.handle.child.kill();
			await buffer.close();
			await output.close();
		}
	}

	it("settles with the abort when the render aborts during a slow buffer read", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-abort-read-"));

		try {
			let signal: AbortSignal | undefined;
			const error = await streamWithSlowSecondRead(temporaryDirectory, async (controller) => {
				signal = controller.signal;
				controller.abort();
			});

			expect(isAbortReason(error, signal)).toBe(true);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 30_000);

	it("settles with the abort when the host crashes during a slow buffer read and the render then aborts", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-crash-read-"));

		try {
			let signal: AbortSignal | undefined;
			const error = await streamWithSlowSecondRead(temporaryDirectory, async (controller, handle) => {
				signal = controller.signal;
				handle.handle.child.kill();
				await handle.handle.exited;
				controller.abort();
			});

			expect(isAbortReason(error, signal)).toBe(true);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("vst-host abort reasons", () => {
	it("rejects a READY wait with the signal's own reason", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-ready-abort-"));
		const stagesPath = join(temporaryDirectory, "stages.json");
		const pidPath = join(temporaryDirectory, "host.pid");

		await writeFile(stagesPath, JSON.stringify([{ pluginPath: "x" }]));

		const controller = new AbortController();
		const reason = new Error("render aborted");

		try {
			const ready = spawnVstHostReady(
				process.execPath,
				[
					stubBinary,
					"--stages-json",
					stagesPath,
					"--sample-rate",
					"48000",
					"--channels",
					"1",
					"--hang-before-ready",
					"--pid-file",
					pidPath,
				],
				{ signal: controller.signal },
			);

			ready.catch(() => undefined);

			const pid = await waitForPid(pidPath);

			controller.abort(reason);

			await expect(settleWithin(ready, "READY wait")).rejects.toBe(reason);

			await waitForProcessAbsence(pid);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("processStreamingThroughVstHost output writes", () => {
	it("starts and finishes no output write after an aborted pass settles", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-late-write-"));
		const stagesPath = join(temporaryDirectory, "stages.json");

		await writeFile(stagesPath, JSON.stringify([{ pluginPath: "x" }]));

		const frames = 2 * 48_000;
		const buffer = new BlockBuffer(temporaryDirectory);

		await buffer.write([Float32Array.from({ length: frames }, (_, index) => Math.sin(index / 100))], 48_000, 32);
		await buffer.flushWrites();

		const handle = await spawnVstHostReady(process.execPath, [
			stubBinary,
			"--stages-json",
			stagesPath,
			"--sample-rate",
			"48000",
			"--channels",
			"1",
		]);
		const controller = new AbortController();
		const output = new BlockBuffer(temporaryDirectory);
		const write = output.write.bind(output);
		const log: Array<string> = [];

		// A slow output buffer: each write takes 100 ms, and the first one aborts the pass.
		vi.spyOn(output, "write").mockImplementation(async (...args) => {
			log.push("write starts");
			controller.abort();
			await delay(100);
			await write(...args);
			log.push("write ends");
		});

		try {
			await processStreamingThroughVstHost(handle, buffer, output, {
				channelCount: 1,
				sampleRate: 48_000,
				bitDepth: 32,
				signal: controller.signal,
			}).catch(() => undefined);

			log.push("pass settled");
			await delay(400);

			expect(log.at(-1)).toBe("pass settled");
			expect(log).toContain("write ends");
		} finally {
			handle.handle.child.kill();
			await buffer.close();
			await output.close();
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 30_000);
});

interface HostRender {
	readonly render: Promise<void>;
	readonly controller: AbortController;
	readonly pidPath: string;
	readonly directory: string;
}

async function renderThroughHost(
	extraArgs: (pidPath: string) => ReadonlyArray<string>,
	monitor: Pick<Parameters<typeof vst3>[0], "monitorIntervalMs" | "monitorSampler"> = {},
): Promise<HostRender> {
	const directory = await mkdtemp(join(tmpdir(), "vst3-host-render-"));
	const inputPath = join(directory, "input.wav");
	const pidPath = join(directory, "host.pid");
	const samples = Float32Array.from({ length: 1024 }, (_, index) => Math.sin(index / 100));

	await writeFile(inputPath, createTestWav(48_000, 1, [samples], "32f"));

	const source = read(inputPath);
	const transform = vst3({
		vstHostPath: process.execPath,
		stages: [{ pluginPath: "/ignored-by-stub.vst3" }],
		extraArgs: extraArgs(pidPath),
		...monitor,
	});

	source.to(transform);
	transform.to(write(join(directory, "output.wav")));

	const controller = new AbortController();
	const render = source.createRenderJob({ signal: controller.signal }).render();

	render.catch(() => undefined);

	return { render, controller, pidPath, directory };
}

async function finishHostRender(run: HostRender): Promise<void> {
	run.controller.abort();
	await settleWithin(run.render, "render cleanup", 15_000).catch(() => undefined);
	await rm(run.directory, { recursive: true, force: true });
}

describe("vst-host teardown and readiness", () => {
	async function renderThroughTeardownStub(mode: string): Promise<HostRender> {
		return renderThroughHost((pidPath) => [teardownStub, "--mode", mode, "--pid-file", pidPath]);
	}

	async function abortAfterReady(mode: string): Promise<{ readonly elapsed: number; readonly pid: number }> {
		const run = await renderThroughTeardownStub(mode);

		try {
			const pid = await waitForPid(run.pidPath);

			// The stub writes its pid first; 500 ms later it has printed READY and the pass is waiting on its output.
			await delay(500);

			const abortedAt = performance.now();

			run.controller.abort();

			await expect(settleWithin(run.render, "aborted render", 15_000)).rejects.toHaveProperty("name", "AbortError");

			return { elapsed: performance.now() - abortedAt, pid };
		} finally {
			await finishHostRender(run);
		}
	}

	it("settles an aborted render within 4 s while a grandchild holds the host's pipes", async () => {
		const { elapsed } = await abortAfterReady("hold-stdio-after-ready");

		expect(elapsed).toBeLessThan(4_000);
	}, 30_000);

	it.skipIf(process.platform === "win32")(
		"settles an aborted render within 4 s and ends a host that ignores SIGTERM",
		async () => {
			const { elapsed, pid } = await abortAfterReady("ignore-sigterm-after-ready");

			expect(elapsed).toBeLessThan(4_000);
			await waitForProcessAbsence(pid);
		},
		30_000,
	);

	it("rejects within 10 s when every attempt exits 3 before READY while a grandchild holds its pipes", async () => {
		const run = await renderThroughTeardownStub("exit-3-before-ready-holding-stdio");
		const startedAt = performance.now();

		try {
			const error = await settleWithin(run.render, "pre-READY crash render", 20_000).then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(performance.now() - startedAt).toBeLessThan(10_000);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message.trimEnd()).toMatch(
				/^vst-host exited before READY \(code 3\): crashed\nend of crash report$/,
			);
		} finally {
			await finishHostRender(run);
		}
	}, 30_000);
});

describe("Vst3Stream host output", () => {
	async function renderFrames(stream: Vst3Stream, samples: Array<Float32Array>): Promise<Array<Float32Array>> {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "vst3-output-"));

		try {
			const output = await stream.setup(
				readableFrom([{ samples, offset: 0, sampleRate: 48_000, bitDepth: 32 }]),
				createTestSetupContext({ temporaryDirectory, sampleRate: 48_000, highWaterMark: 1 }),
			);
			const blocks = await drainBlocks(output);

			return samples.map((_, channel) => {
				const frames = blocks.reduce((total, block) => total + (block.samples[channel]?.length ?? 0), 0);
				const joined = new Float32Array(frames);
				let offset = 0;

				for (const block of blocks) {
					const part = block.samples[channel] ?? new Float32Array(0);

					joined.set(part, offset);
					offset += part.length;
				}

				return joined;
			});
		} finally {
			await stream.destroy().catch(() => undefined);
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}

	it("keeps every frame of 30 s of stereo the host echoes while its input is still being written", async () => {
		const frames = 30 * 48_000;
		const samples = [0, 1].map((channel) =>
			Float32Array.from({ length: frames }, (_, index) => Math.sin(index / (100 + channel))),
		);
		const stream = new Vst3Stream(
			vst3({
				vstHostPath: process.execPath,
				stages: [{ pluginPath: "/ignored-by-stub.vst3" }],
				extraArgs: [stubBinary],
			}),
			createTestStreamContext().context,
		);

		const output = await renderFrames(stream, samples);

		expect(output.map((channel) => channel.length)).toEqual([1_440_000, 1_440_000]);
	}, 60_000);

	it("keeps output that arrives in the READY chunk after an init-crash retry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vst3-ready-output-"));
		const counter = join(directory, "count");
		const stream = new Vst3Stream(
			vst3({
				vstHostPath: process.execPath,
				stages: [{ pluginPath: "/ignored-by-stub.vst3" }],
				extraArgs: [crashBinary, "--crash-file", counter, "--crash-count", "1", "--ready-output-frames", "2048"],
			}),
			createTestStreamContext().context,
		);

		try {
			const output = await renderFrames(stream, [new Float32Array(2048)]);

			expect(output).toEqual([new Float32Array(2048)]);
			expect(Number.parseInt(await readFile(counter, "utf8"), 10)).toBe(2);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("vst-host idle bound", () => {
	it("fails a pass whose host stays idle for 10 liveness samples and ends the host", async () => {
		const run = await renderThroughHost((pidPath) => [stubBinary, "--hang-after-ready", "--pid-file", pidPath], {
			monitorIntervalMs: 50,
			monitorSampler: async () => ({ cpuMs: 0, pidCount: 1 }),
		});
		const startedAt = performance.now();

		try {
			await expect(settleWithin(run.render, "idle render", 8_000)).rejects.toHaveProperty(
				"message",
				"vst-host was idle for 10 liveness samples (0.5 s); a plugin may be waiting on a hidden dialog",
			);
			expect(performance.now() - startedAt).toBeLessThan(3_000);
			await waitForProcessAbsence(await waitForPid(run.pidPath));
		} finally {
			await finishHostRender(run);
		}
	}, 10_000);

	it("never trips on a host that alternates idle and active samples", async () => {
		let samples = 0;
		const run = await renderThroughHost((pidPath) => [stubBinary, "--hang-after-ready", "--pid-file", pidPath], {
			monitorIntervalMs: 50,
			monitorSampler: async () => {
				samples += 1;

				return { cpuMs: Math.floor(samples / 2) * 200, pidCount: 1 };
			},
		});

		try {
			await delay(1_500);
			run.controller.abort();

			const error = await settleWithin(run.render, "aborted render", 8_000).then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(isAbortReason(error, run.controller.signal)).toBe(true);
		} finally {
			await finishHostRender(run);
		}
	}, 15_000);
});
