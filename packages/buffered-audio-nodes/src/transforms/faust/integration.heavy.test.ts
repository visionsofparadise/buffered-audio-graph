import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Block } from "@buffered-audio/core";
import { channelSamples, runTransformStream } from "@buffered-audio/core/testing";
import { binaries, hasBinaryFixtures } from "../../utils/test-binaries";
import { faust, FaustNode } from ".";

const describeIfAddon = hasBinaryFixtures("faustAddon") ? describe : describe.skip;

let temporaryDirectory = "";

function runFaust(node: ReturnType<typeof faust>, blocks: Array<Block>) {
	return runTransformStream(node, blocks, { setup: { temporaryDirectory } });
}

function makeBlock(channels: Array<Float32Array>, offset = 0): Block {
	return { samples: channels, offset, sampleRate: 48000, bitDepth: 32 };
}

function ramp(frames: number, scale = 1): Float32Array {
	const samples = new Float32Array(frames);
	for (let index = 0; index < frames; index++) {
		samples[index] = (index / frames) * scale;
	}
	return samples;
}

function maxError(left: Float32Array, right: Float32Array): number {
	let error = 0;
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		error = Math.max(error, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
	}
	return error;
}

describeIfAddon("faust", () => {
	beforeAll(async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "faust-node-"));
	});

	afterAll(async () => {
		if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
	});

	it("has static metadata and schema defaults", () => {
		expect(FaustNode.nodeName).toBe("Faust");
		const node = faust({ code: "process = _;" });
		expect(node.properties.code).toBe("process = _;");
		expect(node.properties.faustAddonPath).toBe("");
	});

	it("passthrough process = _; on stereo is bit-identical per channel", async () => {
		const left = ramp(256, 0.8);
		const right = ramp(256, -0.5);
		const { blocks } = await runFaust(faust({ code: "process = _;", faustAddonPath: binaries.faustAddon }), [
			makeBlock([left, right]),
		]);

		expect(maxError(channelSamples(blocks, 0), left)).toBe(0);
		expect(maxError(channelSamples(blocks, 1), right)).toBe(0);
	});

	it("process = *(0.5); halves", async () => {
		const input = new Float32Array(64).fill(0.8);
		const { blocks } = await runFaust(faust({ code: "process = *(0.5);", faustAddonPath: binaries.faustAddon }), [
			makeBlock([input]),
		]);
		const output = channelSamples(blocks, 0);

		expect(output.length).toBe(64);
		for (let index = 0; index < output.length; index++) {
			expect(output[index]).toBeCloseTo(0.4, 5);
		}
	});

	it("compiles and runs a stdlib lowpass", async () => {
		const input = ramp(128);
		const { blocks } = await runFaust(
			faust({
				code: `import("stdfaust.lib"); process = fi.lowpass(1, 1000);`,
				faustAddonPath: binaries.faustAddon,
			}),
			[makeBlock([input])],
		);
		const output = channelSamples(blocks, 0);

		expect(output.length).toBe(128);
		expect(output.some((sample) => sample !== 0)).toBe(true);
		expect(maxError(output, input)).toBeGreaterThan(1e-3);
	});

	it("mono process = _ <: _,_; yields 2-channel blocks", async () => {
		const { blocks } = await runFaust(faust({ code: "process = _ <: _,_;", faustAddonPath: binaries.faustAddon }), [
			makeBlock([ramp(32)]),
		]);

		expect(blocks[0]?.samples.length).toBe(2);
		expect(maxError(channelSamples(blocks, 0), channelSamples(blocks, 1))).toBe(0);
	});

	it("runs stereo through a 2-in/2-out program", async () => {
		const left = new Float32Array(48).fill(0.25);
		const right = new Float32Array(48).fill(-0.5);
		const { blocks } = await runFaust(faust({ code: "process = _,_;", faustAddonPath: binaries.faustAddon }), [
			makeBlock([left, right]),
		]);

		expect(blocks[0]?.samples.length).toBe(2);
		expect(maxError(channelSamples(blocks, 0), left)).toBe(0);
		expect(maxError(channelSamples(blocks, 1), right)).toBe(0);
	});

	it("rejects a compile error with the libfaust message", async () => {
		await expect(
			runFaust(faust({ code: "process = not_a_primitive;", faustAddonPath: binaries.faustAddon }), [
				makeBlock([ramp(8)]),
			]),
		).rejects.toThrow(/not_a_primitive/);
	});

	it("rejects a channel-count mismatch", async () => {
		await expect(
			runFaust(faust({ code: "process = _ <: _,_;", faustAddonPath: binaries.faustAddon }), [
				makeBlock([ramp(8), ramp(8)]),
			]),
		).rejects.toThrow("Faust program has 1 inputs and 2 outputs; input has 2 channels");
	});

	it("preserves IIR state across chunk boundaries", async () => {
		const code = `import("stdfaust.lib"); process = fi.lowpass(1, 1000);`;
		const whole = ramp(2048);
		const first = whole.slice(0, 1024);
		const second = whole.slice(1024);
		const node = () => faust({ code, faustAddonPath: binaries.faustAddon });

		const { blocks: oneBlock } = await runFaust(node(), [makeBlock([whole])]);
		const { blocks: split } = await runFaust(node(), [makeBlock([first], 0), makeBlock([second], 1024)]);

		expect(maxError(channelSamples(oneBlock, 0), channelSamples(split, 0))).toBeLessThan(1e-6);
	});

	it("preserves per-channel IIR state across blocks on both channels", async () => {
		const code = `import("stdfaust.lib"); process = fi.lowpass(1, 1000);`;
		const left = ramp(2048, 0.8);
		const right = new Float32Array(2048);
		for (let index = 0; index < right.length; index++) {
			right[index] = index < 1024 ? 0.6 : -0.6;
		}
		const node = () => faust({ code, faustAddonPath: binaries.faustAddon });

		const { blocks: oneBlock } = await runFaust(node(), [makeBlock([left, right])]);
		const { blocks: split } = await runFaust(node(), [
			makeBlock([left.slice(0, 1024), right.slice(0, 1024)], 0),
			makeBlock([left.slice(1024), right.slice(1024)], 1024),
		]);

		expect(maxError(channelSamples(oneBlock, 0), channelSamples(oneBlock, 1))).toBeGreaterThan(0.1);
		expect(maxError(channelSamples(oneBlock, 0), channelSamples(split, 0))).toBeLessThan(1e-6);
		expect(maxError(channelSamples(oneBlock, 1), channelSamples(split, 1))).toBeLessThan(1e-6);
	});

	it("rejects a channel count that changes after dispatch resolves", async () => {
		await expect(
			runFaust(faust({ code: "process = _;", faustAddonPath: binaries.faustAddon }), [
				makeBlock([ramp(8), ramp(8)], 0),
				makeBlock([ramp(8)], 8),
			]),
		).rejects.toThrow("Faust resolved its dispatch against 2 channels; this block has 1 channels");
	});
});
