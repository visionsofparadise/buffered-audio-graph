import { BLOCK_SHIFT, type DtlnBlockStream, WARMUP_SHIFTS } from "./dtln";
import type { BoundedWriter } from "../../../utils/model-blocks";

export const DTLN_SAMPLE_RATE = 16000;
export const CHUNK_FRAMES = 16000;
export const STEP_BATCH_SIZE = 16000;
export const WARMUP_SAMPLES = WARMUP_SHIFTS * BLOCK_SHIFT;

export function stepAllChannels(args: {
	readonly channels: number;
	readonly streams: ReadonlyArray<DtlnBlockStream>;
	readonly inputs: ReadonlyArray<Float32Array>;
	readonly stepBatch: Array<Float32Array>;
	readonly stepBatchLen: number;
	readonly batchSize: number;
	readonly warmupRemaining: number;
}): { stepBatchLen: number; warmupRemaining: number } {
	const { channels, streams, inputs, stepBatch, stepBatchLen, batchSize, warmupRemaining } = args;
	const stepOutputs: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		const stream = streams[channel];
		const input = inputs[channel];

		if (!stream || !input) {
			stepOutputs.push(new Float32Array(BLOCK_SHIFT));

			continue;
		}

		stepOutputs.push(stream.step(input));
	}

	return appendToStepBatch({ samples: stepOutputs, channels, stepBatch, stepBatchLen, batchSize, warmupRemaining });
}

export function appendToStepBatch(args: {
	readonly samples: ReadonlyArray<Float32Array>;
	readonly channels: number;
	readonly stepBatch: Array<Float32Array>;
	readonly stepBatchLen: number;
	readonly batchSize: number;
	readonly warmupRemaining: number;
}): { stepBatchLen: number; warmupRemaining: number } {
	const { samples, channels, stepBatch, stepBatchLen, batchSize, warmupRemaining } = args;
	const length = samples[0]?.length ?? 0;

	if (length === 0) return { stepBatchLen, warmupRemaining };

	let offset = 0;
	let warmupLeft = warmupRemaining;

	if (warmupLeft > 0) {
		const drop = Math.min(warmupLeft, length);

		warmupLeft -= drop;
		offset += drop;
	}

	let batchLen = stepBatchLen;

	while (offset < length) {
		if (batchLen >= batchSize) {
			throw new Error(
				`appendToStepBatch: batch overflow (offset=${String(offset)}, length=${String(length)}, batchLen=${String(batchLen)}, batchSize=${String(batchSize)}). Caller must flush before appending more.`,
			);
		}

		const space = batchSize - batchLen;
		const copy = Math.min(space, length - offset);
		const firstSample = samples[0];

		for (let channel = 0; channel < channels; channel++) {
			const sourceChannel = samples[channel] ?? firstSample;
			const dest = stepBatch[channel];

			if (!sourceChannel || !dest) continue;

			dest.set(sourceChannel.subarray(offset, offset + copy), batchLen);
		}

		batchLen += copy;
		offset += copy;
	}

	return { stepBatchLen: batchLen, warmupRemaining: warmupLeft };
}

export async function commitStepBatch(args: {
	readonly stepBatch: ReadonlyArray<Float32Array>;
	readonly length: number;
	readonly channels: number;
	readonly writer: BoundedWriter;
}): Promise<void> {
	const { stepBatch, length, channels, writer } = args;

	if (length === 0) return;

	const slices: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		const sourceChannel = stepBatch[channel] ?? new Float32Array(length);

		slices.push(sourceChannel.subarray(0, length));
	}

	await writer.write(slices, length);
}
