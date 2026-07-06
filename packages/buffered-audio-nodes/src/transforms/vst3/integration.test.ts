import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { BlockBuffer, type Block, type StreamContext } from "@buffered-audio/core";
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

const dummyInput = (): ReadableStream => new ReadableStream({ start: (controller) => controller.close() });

const populate = async (channels: Array<Float32Array>, sampleRate = 44100): Promise<BlockBuffer> => {
	const buffer = new BlockBuffer();

	await buffer.write(channels, sampleRate, 32);
	await buffer.flushWrites();

	return buffer;
};

// Drives the whole-file transform: runs the subprocess over the buffered input and concatenates the
// enqueued output blocks back into per-channel arrays for round-trip comparison.
const processWholeFile = async (stream: Vst3Stream, buffer: BlockBuffer): Promise<Array<Float32Array>> => {
	const blocks: Array<Block> = [];

	await stream.transform(buffer, (block) => blocks.push(block));

	const channels = blocks[0]?.samples.length ?? 0;
	const totalFrames = blocks.reduce((sum, block) => sum + (block.samples[0]?.length ?? 0), 0);
	const output: Array<Float32Array> = [];

	for (let ch = 0; ch < channels; ch++) {
		const channelData = new Float32Array(totalFrames);
		let offset = 0;

		for (const block of blocks) {
			const source = block.samples[ch];

			if (source) channelData.set(source, offset);
			offset += block.samples[0]?.length ?? 0;
		}

		output.push(channelData);
	}

	return output;
};

describe("Vst3Stream subprocess lifecycle", () => {
	it("spawns the stub binary, receives READY, processes the whole buffer, and tears down cleanly", async () => {
		const stream = new Vst3Stream(vst3({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
			extraArgs: [stubBinary],
		}));

		await stream.setup(dummyInput(), buildContext());

		const channels = 2;
		const frames = 8192;
		const samples: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) {
			const arr = new Float32Array(frames);

			for (let i = 0; i < frames; i++) arr[i] = Math.sin((i / frames) * Math.PI * 2 * (ch + 1));

			samples.push(arr);
		}

		const buffer = await populate(samples);
		const before: Array<Float32Array> = samples.map((channel) => Float32Array.from(channel));

		const after = await processWholeFile(stream, buffer);

		expect(after.length).toBe(channels);
		expect(after[0]!.length).toBe(frames);

		for (let ch = 0; ch < channels; ch++) {
			const original = before[ch]!;
			const result = after[ch]!;

			for (let i = 0; i < frames; i++) {
				expect(result[i]).toBeCloseTo(original[i]!, 6);
			}
		}

		await stream._destroy();
		await buffer.close();
	}, 30_000);

	it("handles a non-block-aligned buffer", async () => {
		// Whole-file mode has no per-block alignment requirement; any positive frame count must round-trip.
		const stream = new Vst3Stream(vst3({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
			extraArgs: [stubBinary],
		}));

		await stream.setup(dummyInput(), buildContext());

		const frames = 1500;
		const samples: Array<Float32Array> = [Float32Array.from({ length: frames }, (_, i) => i / frames)];
		const buffer = await populate(samples);
		const before = Float32Array.from(samples[0]!);

		const after = await processWholeFile(stream, buffer);

		expect(after[0]!.length).toBe(frames);

		for (let i = 0; i < frames; i++) {
			expect(after[0]![i]).toBeCloseTo(before[i]!, 6);
		}

		await stream._destroy();
		await buffer.close();
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

		await stream.setup(dummyInput(), buildContext());

		const frames = 2048;
		const samples: Array<Float32Array> = [Float32Array.from({ length: frames }, (_, i) => i / frames)];
		const buffer = await populate(samples);
		const before = Float32Array.from(samples[0]!);

		const after = await processWholeFile(stream, buffer);

		expect(after[0]!.length).toBe(frames);

		for (let i = 0; i < frames; i++) {
			expect(after[0]![i]).toBeCloseTo(before[i]!, 6);
		}

		expect(await readCount(counter)).toBe(3); // 2 crashed spawns + 1 success

		await stream._destroy();
		await buffer.close();
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
