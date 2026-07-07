import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { type Block, type StreamContext } from "@buffered-audio/core";
import { vst3, Vst3Stream } from ".";
import { spawnVstHostReady, VstHostExitedBeforeReadyError } from "./utils/process";

// Stub binary mimics the real `vst-host` CLI shape (node as binary + stub via `extraArgs`);
// spawns a real subprocess exercising the full lifecycle — hence "integration", not "unit".
const stubBinary = fileURLToPath(new URL("./__fixtures__/stub-binary.mjs", import.meta.url));

// Crashes (exits before READY) for the first N spawns, then behaves like stubBinary; count tracked in a file.
const crashBinary = fileURLToPath(new URL("./__fixtures__/crash-then-ready.mjs", import.meta.url));

const newCounterFile = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "vst3-retry-")), "count");
const readCount = async (path: string): Promise<number> => {
	try {
		return Number.parseInt(await readFile(path, "utf-8"), 10) || 0;
	} catch {
		return 0;
	}
};
const writeStagesFile = async (): Promise<string> => {
	const path = join(await mkdtemp(join(tmpdir(), "vst3-stages-")), "stages.json");

	await writeFile(path, JSON.stringify([{ pluginPath: "x" }]));

	return path;
};

const buildContext = (): StreamContext => ({
	executionProviders: ["cpu"],
	memoryLimit: 64 * 1024 * 1024,
	highWaterMark: 1,
});

// Drives the whole-file transform the way the framework does: feeds the channels through the stream's
// pipe (setup), reads the enqueued output blocks back, and concatenates them per channel for round-trip
// comparison. Reading to completion runs setup -> buffer-accumulate -> flush(transform) -> destroy — the
// same lifecycle a real render drives, so the stages-JSON file is written and live during transform.
const processWholeFile = async (stream: Vst3Stream, channels: Array<Float32Array>, sampleRate = 44100): Promise<Array<Float32Array>> => {
	const input = new ReadableStream<Block>({
		start: (controller) => {
			controller.enqueue({ samples: channels, offset: 0, sampleRate, bitDepth: 32 });
			controller.close();
		},
	});

	const output = await stream.setup(input, buildContext());
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
};

describe("Vst3Stream subprocess lifecycle", () => {
	it("spawns the stub binary, receives READY, processes the whole buffer, and tears down cleanly", async () => {
		const stream = new Vst3Stream(vst3({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
			extraArgs: [stubBinary],
		}));

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

	}, 30_000);

	it("handles a non-block-aligned buffer", async () => {
		// Whole-file mode has no per-block alignment requirement; any positive frame count must round-trip.
		const stream = new Vst3Stream(vst3({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
			extraArgs: [stubBinary],
		}));

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

describe("Vst3Stream init-crash retry", () => {
	it("re-spawns past a non-deterministic init crash and processes cleanly", async () => {
		// Crashes (exit 3221225477 before READY) on the first 2 spawns, succeeds on the 3rd; retry is transparent.
		const counter = await newCounterFile();
		const stream = new Vst3Stream(vst3({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
			extraArgs: [crashBinary, "--crash-file", counter, "--crash-count", "2", "--crash-code", "3221225477"],
		}));

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
		const args = [crashBinary, "--crash-file", counter, "--crash-count", "10", "--crash-code", "3221225477", "--stages-json", stagesPath, "--sample-rate", "48000", "--channels", "1"];

		await expect(spawnVstHostReady(process.execPath, args, { maxAttempts: 3, backoffMs: 0 })).rejects.toBeInstanceOf(VstHostExitedBeforeReadyError);

		expect(await readCount(counter)).toBe(3); // exactly maxAttempts spawns, no more
	}, 30_000);

	it("does not retry a deterministic wrapper error (exit code 2)", async () => {
		const counter = await newCounterFile();
		const stagesPath = await writeStagesFile();
		const args = [crashBinary, "--crash-file", counter, "--crash-count", "10", "--crash-code", "2", "--stages-json", stagesPath, "--sample-rate", "48000", "--channels", "1"];

		await expect(spawnVstHostReady(process.execPath, args, { maxAttempts: 5, backoffMs: 0 })).rejects.toBeInstanceOf(VstHostExitedBeforeReadyError);

		expect(await readCount(counter)).toBe(1); // failed fast — single spawn, no retries
	}, 30_000);
});
