import type { OnnxSession } from "../../../utils/onnx-runtime";
import type { Block } from "@buffered-audio/core";

const WINDOW_FRAMES = 512;
const CONTEXT_FRAMES = 64;
const INPUT_FRAMES = CONTEXT_FRAMES + WINDOW_FRAMES;
const STATE_DIMS: ReadonlyArray<number> = [2, 1, 128];

export async function runVadWindows(
	session: OnnxSession,
	blocks: AsyncIterable<Block>,
	onWindow?: (framesDone: number) => void,
): Promise<Float32Array> {
	const probabilities: Array<number> = [];
	const input = new Float32Array(INPUT_FRAMES);
	const pending = new Float32Array(WINDOW_FRAMES);
	let pendingLength = 0;
	let framesDone = 0;
	let stateData = new Float32Array(2 * 1 * 128);

	const runWindow = (windowSamples: Float32Array): void => {
		input.set(windowSamples, CONTEXT_FRAMES);

		const outputs = session.run({
			input: { data: input, dims: [1, INPUT_FRAMES] },
			state: { data: stateData, dims: STATE_DIMS },
		});

		probabilities.push(outputs.output?.data[0] ?? 0);

		const nextState = outputs.stateN;

		if (nextState) {
			if (nextState.data.length === stateData.length) {
				stateData.set(nextState.data);
			} else {
				stateData = new Float32Array(nextState.data);
			}
		}

		input.copyWithin(0, INPUT_FRAMES - CONTEXT_FRAMES);
	};

	for await (const block of blocks) {
		const samples = block.samples[0];

		if (samples === undefined || samples.length === 0) continue;

		let offset = 0;

		while (offset < samples.length) {
			const take = Math.min(WINDOW_FRAMES - pendingLength, samples.length - offset);

			pending.set(samples.subarray(offset, offset + take), pendingLength);
			pendingLength += take;
			offset += take;
			framesDone += take;

			if (pendingLength === WINDOW_FRAMES) {
				runWindow(pending);
				onWindow?.(framesDone);
				pendingLength = 0;
			}
		}
	}

	if (pendingLength > 0) {
		pending.fill(0, pendingLength);
		runWindow(pending);
		onWindow?.(framesDone);
	}

	return Float32Array.from(probabilities);
}
