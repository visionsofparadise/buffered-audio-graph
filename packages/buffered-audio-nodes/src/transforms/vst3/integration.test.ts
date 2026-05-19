import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ChunkBuffer, type StreamContext } from "@buffered-audio/core";
import { Vst3Stream } from ".";

// Stub binary mimics the real `vst-host` whole-file CLI shape: parses
// --stages-json/--sample-rate/--channels, prints READY, echoes stdin → stdout.
// We pass `process.execPath` (node) as the binary and inject the stub's path
// via `extraArgs`; this exercises the full spawn / READY / write / read /
// teardown lifecycle without needing the PyInstaller bundle, but DOES spawn a
// real subprocess — hence "integration", not "unit".
const stubBinary = fileURLToPath(new URL("./__fixtures__/stub-binary.mjs", import.meta.url));

const buildContext = (): StreamContext => ({
	executionProviders: ["cpu"],
	memoryLimit: 64 * 1024 * 1024,
	highWaterMark: 1,
	visited: new Set(),
});

const dummyInput = (): ReadableStream => new ReadableStream({ start: (controller) => controller.close() });

const populate = async (channels: Array<Float32Array>, sampleRate = 44100): Promise<ChunkBuffer> => {
	const buffer = new ChunkBuffer();

	await buffer.write(channels, sampleRate, 32);
	await buffer.flushWrites();

	return buffer;
};

describe("Vst3Stream subprocess lifecycle", () => {
	it("spawns the stub binary, receives READY, processes the whole buffer, and tears down cleanly", async () => {
		const stream = new Vst3Stream({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
			extraArgs: [stubBinary],
			bufferSize: Infinity,
			overlap: 0,
		});

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

		await stream._process(buffer);

		const after = await buffer.read(buffer.frames);

		expect(after.samples.length).toBe(channels);
		expect(after.samples[0]!.length).toBe(frames);

		for (let ch = 0; ch < channels; ch++) {
			const original = before[ch]!;
			const result = after.samples[ch]!;

			for (let i = 0; i < frames; i++) {
				expect(result[i]).toBeCloseTo(original[i]!, 6);
			}
		}

		await stream._teardown();
		await buffer.close();
	}, 30_000);

	it("handles a non-block-aligned buffer", async () => {
		// Whole-file mode has no per-block alignment requirement; any positive
		// frame count must round-trip through the stub.
		const stream = new Vst3Stream({
			vstHostPath: process.execPath,
			stages: [{ pluginPath: "/dev/null/ignored-by-stub.vst3" }],
			extraArgs: [stubBinary],
			bufferSize: Infinity,
			overlap: 0,
		});

		await stream.setup(dummyInput(), buildContext());

		const frames = 1500;
		const samples: Array<Float32Array> = [Float32Array.from({ length: frames }, (_, i) => i / frames)];
		const buffer = await populate(samples);
		const before = Float32Array.from(samples[0]!);

		await stream._process(buffer);

		const after = await buffer.read(buffer.frames);

		expect(after.samples[0]!.length).toBe(frames);

		for (let i = 0; i < frames; i++) {
			expect(after.samples[0]![i]).toBeCloseTo(before[i]!, 6);
		}

		await stream._teardown();
		await buffer.close();
	}, 30_000);
});
