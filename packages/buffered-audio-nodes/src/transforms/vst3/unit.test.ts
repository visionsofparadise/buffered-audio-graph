import { describe, it, expect } from "vitest";
import { type Block, type StreamContext } from "@buffered-audio/core";
import { schema, vst3, Vst3Node, Vst3PassthroughStream, Vst3Stream } from ".";

const buildContext = (): StreamContext => ({
	executionProviders: ["cpu"],
	memoryLimit: 64 * 1024 * 1024,
	highWaterMark: 1,
});

const collect = async (readable: ReadableStream<Block>): Promise<Array<Block>> => {
	const blocks: Array<Block> = [];
	const reader = readable.getReader();

	for (;;) {
		const { done, value } = await reader.read();

		if (done) break;
		if (value) blocks.push(value);
	}

	return blocks;
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
		expect(Vst3Node.nodeName).toBe("VST3");
		expect(Vst3Node.nodeDescription).toMatch(/VST3 effect plugins/);
	});

	it("uses Vst3Stream as its stream class", () => {
		expect(Vst3Node.streamClass).toBe(Vst3Stream);
	});
});

describe("Vst3PassthroughStream", () => {
	it("passes audio through unchanged sample-for-sample without spawning a subprocess", async () => {
		// bypass is now resolved by the executor (the node is skipped); the passthrough stream is the
		// unbuffered identity used where a passthrough is wired directly. The missing paths would make
		// any spawn fail loudly, proving no subprocess is spawned.
		const node = vst3({ vstHostPath: "/missing/binary", stages: [{ pluginPath: "/missing/plugin.vst3" }], bypass: true });
		const stream = new Vst3PassthroughStream(node);

		const samples = [Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.5]), Float32Array.from([-0.1, 0.2, -0.3, 0.4, -0.5])];
		const before: Array<Float32Array> = samples.map((channel) => Float32Array.from(channel));

		const input = new ReadableStream<Block>({
			start(controller) {
				controller.enqueue({ samples, offset: 0, sampleRate: 44100, bitDepth: 32 });
				controller.close();
			},
		});

		const output = await stream.setup(input, buildContext());
		const blocks = await collect(output);

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
