import type { MixedRadixFft } from "@buffered-audio/utils";
import type { OnnxSession } from "../../../utils/onnx-runtime";
import { stft7680IntoTensor, istft7680FromTensor } from "./stft";

const DIM_F = 3072;
const DIM_T = 256;
const CHANNEL_STRIDE = DIM_F * DIM_T;

export function buildTransitionWindow(segmentLength: number, transitionPower: number): Float32Array {
	const window = new Float32Array(segmentLength);
	const half = segmentLength / 2;

	for (let index = 0; index < half; index++) {
		const value = Math.pow((index + 1) / half, transitionPower);

		window[index] = value;
		window[segmentLength - 1 - index] = value;
	}

	return window;
}

interface SegmentWorkspace {
	readonly segLeft: Float32Array;
	readonly segRight: Float32Array;
	readonly inputData: Float32Array;
	readonly segOutLeft: Float32Array;
	readonly segOutRight: Float32Array;
	readonly istftWindowSum: Float32Array;
}

export function createSegmentWorkspace(segmentLength: number): SegmentWorkspace {
	return {
		segLeft: new Float32Array(segmentLength),
		segRight: new Float32Array(segmentLength),
		inputData: new Float32Array(4 * CHANNEL_STRIDE),
		segOutLeft: new Float32Array(segmentLength),
		segOutRight: new Float32Array(segmentLength),
		istftWindowSum: new Float32Array(segmentLength),
	};
}

export function processSegment(
	left: Float32Array,
	right: Float32Array,
	offset: number,
	chunkLen: number,
	isMono: boolean,
	workspace: SegmentWorkspace,
	fft: MixedRadixFft,
	session: OnnxSession,
	compensate: number,
): { readonly left: Float32Array; readonly right: Float32Array } | undefined {
	const { segLeft, segRight, inputData, segOutLeft, segOutRight, istftWindowSum } = workspace;

	segLeft.fill(0);

	for (let index = 0; index < chunkLen; index++) {
		segLeft[index] = left[offset + index] ?? 0;
	}

	inputData.fill(0);
	stft7680IntoTensor(fft, segLeft, inputData, 0 * CHANNEL_STRIDE, 2 * CHANNEL_STRIDE);

	if (isMono) {
		inputData.copyWithin(1 * CHANNEL_STRIDE, 0 * CHANNEL_STRIDE, 1 * CHANNEL_STRIDE);
		inputData.copyWithin(3 * CHANNEL_STRIDE, 2 * CHANNEL_STRIDE, 3 * CHANNEL_STRIDE);
	} else {
		segRight.fill(0);

		for (let index = 0; index < chunkLen; index++) {
			segRight[index] = right[offset + index] ?? 0;
		}

		stft7680IntoTensor(fft, segRight, inputData, 1 * CHANNEL_STRIDE, 3 * CHANNEL_STRIDE);
	}

	const result = session.run({
		input: { data: inputData, dims: [1, 4, DIM_F, DIM_T] },
	});

	const modelOutput = result.output;

	if (!modelOutput) return undefined;

	segOutLeft.fill(0);
	istftWindowSum.fill(0);
	istft7680FromTensor(fft, modelOutput.data, 0 * CHANNEL_STRIDE, 2 * CHANNEL_STRIDE, DIM_T, compensate, segOutLeft, istftWindowSum);

	if (isMono) {
		segOutRight.set(segOutLeft);
	} else {
		segOutRight.fill(0);
		istftWindowSum.fill(0);
		istft7680FromTensor(fft, modelOutput.data, 1 * CHANNEL_STRIDE, 3 * CHANNEL_STRIDE, DIM_T, compensate, segOutRight, istftWindowSum);
	}

	return { left: segOutLeft, right: segOutRight };
}
