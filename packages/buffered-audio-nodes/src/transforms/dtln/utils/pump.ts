import type { BlockBuffer } from "@buffered-audio/core";
import type { ResampleStream } from "@buffered-audio/utils";
import { BLOCK_SHIFT, type DtlnBlockStream, WARMUP_SHIFTS } from "./dtln";

export const DTLN_SAMPLE_RATE = 16000;
export const CHUNK_FRAMES = 16000; // 1 s at 16 kHz
export const RESAMPLE_DRAIN_CHUNK = 16384;
export const STEP_BATCH_SIZE = 16000; // ~125 BLOCK_SHIFTs
export const WARMUP_SAMPLES = WARMUP_SHIFTS * BLOCK_SHIFT; // 384

export interface StreamPair {
	readonly resampleIn: ResampleStream;
	readonly resampleOut: ResampleStream;
}

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

	for (let ch = 0; ch < channels; ch++) {
		const stream = streams[ch];
		const input = inputs[ch];

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

	// Drop warm-up samples: zeros from the pre-first-inference sliding window, dropped to match `processDtlnFrames`.
	if (warmupLeft > 0) {
		const drop = Math.min(warmupLeft, length);

		warmupLeft -= drop;
		offset += drop;
	}

	let batchLen = stepBatchLen;

	while (offset < length) {
		if (batchLen >= batchSize) {
			// Caller must flush the batch before appending; this guards that contract.
			throw new Error(`appendToStepBatch: batch overflow (offset=${String(offset)}, length=${String(length)}, batchLen=${String(batchLen)}, batchSize=${String(batchSize)}). Caller must flush before appending more.`);
		}

		const space = batchSize - batchLen;
		const copy = Math.min(space, length - offset);
		const firstSample = samples[0];

		for (let ch = 0; ch < channels; ch++) {
			const src = samples[ch] ?? firstSample;
			const dest = stepBatch[ch];

			if (!src || !dest) continue;
			dest.set(src.subarray(offset, offset + copy), batchLen);
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
	readonly pair: StreamPair | undefined;
	readonly output: BlockBuffer;
	readonly sourceRate: number;
	readonly bitDepth: number | undefined;
	readonly originalFrames: number;
	readonly writerState: { written: number };
}): Promise<void> {
	const { stepBatch, length, channels, pair, output, sourceRate, bitDepth, originalFrames, writerState } = args;

	if (length === 0) return;

	const slices: Array<Float32Array> = [];

	for (let ch = 0; ch < channels; ch++) {
		const src = stepBatch[ch] ?? new Float32Array(length);

		slices.push(src.subarray(0, length));
	}

	if (pair) {
		await pair.resampleOut.write(slices);
	} else {
		const remaining = Math.max(0, originalFrames - writerState.written);

		if (remaining > 0) {
			const take = Math.min(length, remaining);
			const writeChannels = take === length ? slices : slices.map((channel) => channel.subarray(0, take));

			await output.write(writeChannels, sourceRate, bitDepth);
			writerState.written += take;
		}
	}
}

export async function drainResampleOutToBuffer(args: {
	readonly resampleOut: ResampleStream;
	readonly output: BlockBuffer;
	readonly channels: number;
	readonly sourceRate: number;
	readonly bitDepth: number | undefined;
	readonly originalFrames: number;
	readonly writerState: { written: number };
}): Promise<void> {
	const { resampleOut, output, channels, sourceRate, bitDepth, originalFrames, writerState } = args;

	for (;;) {
		const chunk = await resampleOut.read(RESAMPLE_DRAIN_CHUNK);
		const got = chunk[0]?.length ?? 0;

		if (got === 0) return; // EOF

		await commitResampledFrames({ chunk, channels, output, sourceRate, bitDepth, originalFrames, writerState });
	}
}

export async function pullNextChunkAt16k(args: {
	readonly buffer: BlockBuffer;
	readonly pair: StreamPair | undefined;
	readonly channels: number;
	readonly frames: number;
}): Promise<ReadonlyArray<Float32Array> | undefined> {
	const { buffer, pair, channels, frames } = args;

	if (!pair) {
		const chunk = await buffer.read(frames);
		const got = chunk.samples[0]?.length ?? 0;

		if (got === 0) return undefined;

		const out: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) {
			out.push(chunk.samples[ch] ?? chunk.samples[0] ?? new Float32Array(got));
		}

		return out;
	}

	const out = await pair.resampleIn.read(frames);
	const got = out[0]?.length ?? 0;

	if (got === 0) return undefined;

	return out;
}

export async function pumpSourceToResampleIn(args: {
	readonly buffer: BlockBuffer;
	readonly resampleIn: ResampleStream;
	readonly channels: number;
	readonly chunkFrames: number;
}): Promise<void> {
	const { buffer, resampleIn, channels, chunkFrames } = args;

	for (;;) {
		const sourceChunk = await buffer.read(chunkFrames);
		const sourceFrames = sourceChunk.samples[0]?.length ?? 0;

		if (sourceFrames === 0) break;

		const sourceChannels: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) {
			sourceChannels.push(sourceChunk.samples[ch] ?? sourceChunk.samples[0] ?? new Float32Array(sourceFrames));
		}

		await resampleIn.write(sourceChannels);

		if (sourceFrames < chunkFrames) break;
	}

	await resampleIn.end();
}

export async function commitResampledFrames(args: {
	readonly chunk: ReadonlyArray<Float32Array>;
	readonly channels: number;
	readonly output: BlockBuffer;
	readonly sourceRate: number;
	readonly bitDepth: number | undefined;
	readonly originalFrames: number;
	readonly writerState: { written: number };
}): Promise<void> {
	const { chunk, channels, output, sourceRate, bitDepth, originalFrames, writerState } = args;
	const firstChannel = chunk[0];
	const got = firstChannel?.length ?? 0;

	if (got === 0 || !firstChannel) return;

	const remaining = originalFrames - writerState.written;

	if (remaining <= 0) return;

	const take = Math.min(got, remaining);
	const writeChannels: Array<Float32Array> = [];

	for (let ch = 0; ch < channels; ch++) {
		const src = chunk[ch] ?? firstChannel;

		writeChannels.push(take === got ? src : src.subarray(0, take));
	}

	await output.write(writeChannels, sourceRate, bitDepth);
	writerState.written += take;
}

export async function padTail(output: BlockBuffer, channels: number, originalFrames: number, written: number, sourceRate: number, bitDepth: number | undefined): Promise<void> {
	if (written >= originalFrames) return;

	const missing = originalFrames - written;
	const padChannels: Array<Float32Array> = [];

	for (let channel = 0; channel < Math.max(1, channels); channel++) {
		padChannels.push(new Float32Array(missing));
	}

	await output.write(padChannels, sourceRate, bitDepth);
}
