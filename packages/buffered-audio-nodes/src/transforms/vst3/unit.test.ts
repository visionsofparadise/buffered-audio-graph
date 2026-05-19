import { describe, it, expect } from "vitest";
import { ChunkBuffer, type StreamContext } from "@buffered-audio/core";
import { schema, vst3, Vst3Node, Vst3PassthroughStream, Vst3Stream } from ".";

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

	it("accepts a parameters override map", () => {
		const result = schema.parse({
			stages: [
				{ pluginPath: "/p", parameters: { freq: 5506, threshold: -16, sidechain: "HighPass ", bypass: false } },
			],
		});

		expect(result.stages[0]!.parameters).toEqual({ freq: 5506, threshold: -16, sidechain: "HighPass ", bypass: false });
	});

	it("rejects a parameters value of an unsupported type", () => {
		const result = schema.safeParse({ stages: [{ pluginPath: "/p", parameters: { freq: { nested: 5506 } } }] });

		expect(result.success).toBe(false);
	});

	it("rejects a non-boolean bypass", () => {
		const result = schema.safeParse({ stages: [{ pluginPath: "/p" }], bypass: "yes" });

		expect(result.success).toBe(false);
	});
});

describe("Vst3Node", () => {
	it("identifies VST3 nodes via .is()", () => {
		const node = vst3({ vstHostPath: "x", stages: [{ pluginPath: "y" }] });

		expect(Vst3Node.is(node)).toBe(true);
		expect(node.type[2]).toBe("vst3");
	});

	it("exposes the expected static metadata", () => {
		expect(Vst3Node.moduleName).toBe("VST3");
		expect(Vst3Node.moduleDescription).toMatch(/VST3 effect plugins/);
	});

	it("returns a passthrough stream when bypass is true", () => {
		const node = vst3({ vstHostPath: "/none", stages: [{ pluginPath: "/none" }], bypass: true });
		const stream = node.createStream();

		expect(stream).toBeInstanceOf(Vst3PassthroughStream);
		expect(stream).not.toBeInstanceOf(Vst3Stream);
	});

	it("returns a Vst3Stream when bypass is false", () => {
		const node = vst3({ vstHostPath: "/none", stages: [{ pluginPath: "/none" }], bypass: false });
		const stream = node.createStream();

		expect(stream).toBeInstanceOf(Vst3Stream);
	});
});

describe("Vst3Node bypass short-circuit", () => {
	it("passes audio through unchanged sample-for-sample when bypass is true", async () => {
		const node = vst3({ vstHostPath: "/missing/binary", stages: [{ pluginPath: "/missing/plugin.vst3" }], bypass: true });
		const stream = node.createStream();

		// Bypass must NOT spawn a subprocess; missing paths would make any spawn
		// fail loudly. The Vst3PassthroughStream type assertion already proves
		// the short-circuit; this is a behavioural cross-check on the in-process
		// passthrough.
		await stream.setup(dummyInput(), buildContext());

		const samples = [Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.5]), Float32Array.from([-0.1, 0.2, -0.3, 0.4, -0.5])];
		const buffer = await populate(samples);

		const before: Array<Float32Array> = samples.map((channel) => Float32Array.from(channel));

		stream._process(buffer);

		const after = await buffer.read(buffer.frames);

		for (let ch = 0; ch < samples.length; ch++) {
			const original = before[ch]!;
			const result = after.samples[ch]!;

			expect(result.length).toBe(original.length);

			for (let i = 0; i < original.length; i++) {
				expect(result[i]).toBe(original[i]);
			}
		}

		await buffer.close();
	});
});
