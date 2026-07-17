import { describe, expect, it, vi } from "vitest";
import { createTestSetupContext, createTestStreamContext } from "@buffered-audio/core/testing";
import type { FfmpegProperties } from "../transforms/ffmpeg";
import { createResampleComposition } from "./resample-composition";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: childProcessMocks.spawn,
}));

const MODEL_RATE = 16000;
const EDGE_RATE = 44100;

describe("createResampleComposition", () => {
	it("returns nothing and leaves the cursor untouched when the edge rate is already the model rate", () => {
		const context = createTestSetupContext({ sourceSampleRate: MODEL_RATE, sampleRate: MODEL_RATE });

		const composition = createResampleComposition({ context, streamContext: createTestStreamContext().context, ffmpegPath: "ffmpeg", modelRate: MODEL_RATE });

		expect(composition).toBeUndefined();
		expect(context.sampleRate).toBe(MODEL_RATE);
	});

	it("restores the cursor to the edge rate after building both resamplers", () => {
		const context = createTestSetupContext({ sourceSampleRate: EDGE_RATE, sampleRate: EDGE_RATE });

		const composition = createResampleComposition({ context, streamContext: createTestStreamContext().context, ffmpegPath: "ffmpeg", modelRate: MODEL_RATE });

		expect(composition).toBeDefined();
		expect(context.sampleRate).toBe(EDGE_RATE);
	});

	it("builds each side with its own aresample filter and outgoing rate", () => {
		const context = createTestSetupContext({ sourceSampleRate: EDGE_RATE, sampleRate: EDGE_RATE });

		const composition = createResampleComposition({ context, streamContext: createTestStreamContext().context, ffmpegPath: "/bin/ffmpeg", modelRate: MODEL_RATE });

		if (!composition) throw new Error("expected a composition");

		const up = composition.upResample.node.properties as FfmpegProperties;
		const down = composition.downResample.node.properties as FfmpegProperties;

		expect(up.args).toEqual(["-af", `aresample=${MODEL_RATE}`]);
		expect(up.outputSampleRate).toBe(MODEL_RATE);
		expect(up.ffmpegPath).toBe("/bin/ffmpeg");
		expect(down.args).toEqual(["-af", `aresample=${EDGE_RATE}`]);
		expect(down.outputSampleRate).toBe(EDGE_RATE);
		expect(down.ffmpegPath).toBe("/bin/ffmpeg");
	});

	it("spawns no child process at construction", () => {
		const context = createTestSetupContext({ sourceSampleRate: EDGE_RATE, sampleRate: EDGE_RATE });

		createResampleComposition({ context, streamContext: createTestStreamContext().context, ffmpegPath: "ffmpeg", modelRate: MODEL_RATE });

		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
	});
});
