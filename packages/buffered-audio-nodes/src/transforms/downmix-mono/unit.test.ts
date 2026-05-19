import { describe, it, expect } from "vitest";
import { ChunkBuffer } from "@buffered-audio/core";
import { downmixMono, DownmixMonoNode } from ".";

function makeChunk(channelValues: Array<number>, frames = 256) {
	return {
		samples: channelValues.map((val) => new Float32Array(frames).fill(val)),
		offset: 0,
		sampleRate: 48000,
		bitDepth: 32,
	};
}

async function applyDownmix(chunk: ReturnType<typeof makeChunk>) {
	const node = downmixMono();
	const stream = node.createStream();
	const buffer = new ChunkBuffer();
	try {
		await stream._buffer(chunk, buffer);
		return stream._unbuffer(chunk);
	} finally {
		await buffer.close();
	}
}

describe("DownmixMonoNode", () => {
	it("has correct static metadata", () => {
		expect(DownmixMonoNode.moduleName).toBe("Downmix Mono");
	});

	it("passes mono input unchanged", async () => {
		const chunk = makeChunk([0.5]);
		const output = await applyDownmix(chunk);
		expect(output.samples.length).toBe(1);
		expect(output.samples[0]![0]).toBeCloseTo(0.5, 5);
	});

	it("averages stereo to mono", async () => {
		const chunk = makeChunk([0.8, 0.4]);
		const output = await applyDownmix(chunk);
		expect(output.samples.length).toBe(1);
		expect(output.samples[0]![0]).toBeCloseTo(0.6, 5);
	});

	it("averages 4 channels to mono", async () => {
		const chunk = makeChunk([0.4, 0.8, 0.2, 0.6]);
		const output = await applyDownmix(chunk);
		expect(output.samples.length).toBe(1);
		// (0.4 + 0.8 + 0.2 + 0.6) / 4 = 0.5
		expect(output.samples[0]![0]).toBeCloseTo(0.5, 5);
	});

	it("preserves frame count", async () => {
		const chunk = makeChunk([0.5, 0.5], 1024);
		const output = await applyDownmix(chunk);
		expect(output.samples[0]!.length).toBe(1024);
	});

	it("handles channels with different signs correctly", async () => {
		const chunk = makeChunk([0.5, -0.5]);
		const output = await applyDownmix(chunk);
		expect(output.samples[0]![0]).toBeCloseTo(0.0, 5);
	});
});
