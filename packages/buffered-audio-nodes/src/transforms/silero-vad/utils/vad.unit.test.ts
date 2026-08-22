import { describe, expect, it } from "vitest";
import { runVadWindows } from "./vad";
import type { Block } from "@buffered-audio/core";
import type { OnnxSession } from "../../../utils/onnx-runtime";

const WINDOW_FRAMES = 512;
const CONTEXT_FRAMES = 64;
const INPUT_FRAMES = CONTEXT_FRAMES + WINDOW_FRAMES;
const STATE_SIZE = 2 * 1 * 128;

interface RunCall {
	readonly input: Float32Array;
	readonly state: Float32Array;
}

function createRecordingSession(probabilities: Array<number>): {
	readonly session: OnnxSession;
	readonly calls: Array<RunCall>;
} {
	const calls: Array<RunCall> = [];
	let windowIndex = 0;

	const session: OnnxSession = {
		run(inputs) {
			const inputTensor = inputs.input;
			const stateTensor = inputs.state;

			if (!inputTensor || !stateTensor) throw new Error("silero-vad stub: missing inputs");

			calls.push({
				input: new Float32Array(inputTensor.data),
				state: new Float32Array(stateTensor.data),
			});

			const nextState = new Float32Array(stateTensor.data);

			nextState[0] = windowIndex + 1;

			const probability = probabilities[windowIndex] ?? 0;

			windowIndex += 1;

			return {
				output: { data: new Float32Array([probability]), dims: [1, 1] },
				stateN: { data: nextState, dims: [2, 1, 128] },
			};
		},
		dispose() {},
	};

	return { session, calls };
}

function samplesCountingTo(frames: number): Float32Array {
	const samples = new Float32Array(frames);

	for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
		samples[frameIndex] = frameIndex + 1;
	}

	return samples;
}

async function* blocksFrom(...channels: Array<Float32Array>): AsyncGenerator<Block> {
	for (const samples of channels) {
		yield { samples: [samples], offset: 0, sampleRate: 16000, bitDepth: 32 };
	}
}

describe("runVadWindows", () => {
	it("feeds 576-sample inputs with zero context on the first window", async () => {
		const { session, calls } = createRecordingSession([0.1, 0.2]);
		const samples = samplesCountingTo(WINDOW_FRAMES * 2);

		await runVadWindows(session, blocksFrom(samples));

		expect(calls.length).toBe(2);
		expect(calls[0]?.input.length).toBe(INPUT_FRAMES);
		expect(Array.from(calls[0]?.input.subarray(0, CONTEXT_FRAMES) ?? [])).toEqual(
			Array.from({ length: CONTEXT_FRAMES }, () => 0),
		);
		expect(Array.from(calls[0]?.input.subarray(CONTEXT_FRAMES) ?? [])).toEqual(
			Array.from(samples.subarray(0, WINDOW_FRAMES)),
		);
	});

	it("carries the last 64 input samples as the next window's context", async () => {
		const { session, calls } = createRecordingSession([0.1, 0.2]);
		const samples = samplesCountingTo(WINDOW_FRAMES * 2);

		await runVadWindows(session, blocksFrom(samples));

		const previousTail = calls[0]?.input.subarray(INPUT_FRAMES - CONTEXT_FRAMES);

		expect(Array.from(calls[1]?.input.subarray(0, CONTEXT_FRAMES) ?? [])).toEqual(
			Array.from(previousTail ?? []),
		);
		expect(Array.from(calls[1]?.input.subarray(CONTEXT_FRAMES) ?? [])).toEqual(
			Array.from(samples.subarray(WINDOW_FRAMES, WINDOW_FRAMES * 2)),
		);
	});

	it("feeds the previous stateN back as state", async () => {
		const { session, calls } = createRecordingSession([0.1, 0.2, 0.3]);
		const samples = samplesCountingTo(WINDOW_FRAMES * 3);

		await runVadWindows(session, blocksFrom(samples));

		expect(calls[0]?.state.length).toBe(STATE_SIZE);
		expect(Array.from(calls[0]?.state ?? []).every((value) => value === 0)).toBe(true);
		expect(calls[1]?.state[0]).toBe(1);
		expect(calls[2]?.state[0]).toBe(2);
	});

	it("zero-pads a trailing short window", async () => {
		const leftover = 88;
		const { session, calls } = createRecordingSession([0.1, 0.2]);
		const samples = samplesCountingTo(WINDOW_FRAMES + leftover);

		await runVadWindows(session, blocksFrom(samples));

		expect(calls.length).toBe(2);

		const trailingNew = calls[1]?.input.subarray(CONTEXT_FRAMES) ?? new Float32Array();

		expect(Array.from(trailingNew.subarray(0, leftover))).toEqual(
			Array.from(samples.subarray(WINDOW_FRAMES)),
		);
		expect(Array.from(trailingNew.subarray(leftover)).every((value) => value === 0)).toBe(true);
	});

	it("collects probabilities in window order", async () => {
		const { session } = createRecordingSession([0.5, 0.25, 0.75]);
		const samples = samplesCountingTo(WINDOW_FRAMES * 3);

		const probabilities = await runVadWindows(session, blocksFrom(samples));

		expect(Array.from(probabilities)).toEqual([0.5, 0.25, 0.75]);
	});

	it("assembles windows across block boundaries", async () => {
		const { session, calls } = createRecordingSession([0.4]);
		const samples = samplesCountingTo(WINDOW_FRAMES);

		await runVadWindows(session, blocksFrom(samples.subarray(0, 200), samples.subarray(200)));

		expect(calls.length).toBe(1);
		expect(Array.from(calls[0]?.input.subarray(CONTEXT_FRAMES) ?? [])).toEqual(Array.from(samples));
	});

	it("returns an empty array when no samples arrive", async () => {
		const { session, calls } = createRecordingSession([]);

		const probabilities = await runVadWindows(session, blocksFrom());

		expect(calls.length).toBe(0);
		expect(probabilities.length).toBe(0);
	});

	it("reports cumulative analysis frames through onWindow", async () => {
		const { session } = createRecordingSession([0.1, 0.2]);
		const samples = samplesCountingTo(WINDOW_FRAMES + 40);
		const reported: Array<number> = [];

		await runVadWindows(session, blocksFrom(samples), (framesDone) => {
			reported.push(framesDone);
		});

		expect(reported).toEqual([WINDOW_FRAMES, WINDOW_FRAMES + 40]);
	});
});
