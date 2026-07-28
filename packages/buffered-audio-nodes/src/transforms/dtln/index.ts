import {
	createProgressGate,
	TransformNode,
	type StreamSetupContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { initFftBackend, type FftBackend } from "@buffered-audio/utils";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import {
	createFfmpegPathField,
	createFftwAddonPathField,
	createOnnxAddonPathField,
	createVkfftAddonPathField,
} from "../../utils/binary-fields";
import { BoundedWriter, pullModelChunk } from "../../utils/model-blocks";
import { filterOnnxProviders } from "../../utils/onnx-providers";
import { WholeFileOnnxStream, type ModelPassArgs } from "../../utils/onnx-stream";
import { BLOCK_LEN, BLOCK_SHIFT, DtlnBlockStream } from "./utils/dtln";
import {
	appendToStepBatch,
	CHUNK_FRAMES,
	commitStepBatch,
	DTLN_SAMPLE_RATE,
	STEP_BATCH_SIZE,
	stepAllChannels,
	WARMUP_SAMPLES,
} from "./utils/pump";
import type { OnnxSession } from "../../utils/onnx-runtime";

const schema = z.object({
	modelPath1: z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			accept: ".onnx",
			binary: "dtln-model_1",
			download: "https://github.com/breizhn/DTLN",
		})
		.describe("DTLN magnitude mask model (.onnx)"),
	modelPath2: z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			accept: ".onnx",
			binary: "dtln-model_2",
			download: "https://github.com/breizhn/DTLN",
		})
		.describe("DTLN time-domain model (.onnx)"),
	ffmpegPath: createFfmpegPathField(),
	onnxAddonPath: createOnnxAddonPathField(),
	vkfftAddonPath: createVkfftAddonPathField(),
	fftwAddonPath: createFftwAddonPathField(),
});

export interface DtlnProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class DtlnStream extends WholeFileOnnxStream<DtlnNode> {
	protected override readonly modelChunkFrames = CHUNK_FRAMES;

	private session1!: OnnxSession;
	private session2!: OnnxSession;
	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };

	override _setup(context: StreamSetupContext): void {
		const onnxProviders = filterOnnxProviders(context.executionProviders);

		this.session1 = this.createSession(this.properties.modelPath1, { executionProviders: onnxProviders });
		this.session2 = this.createSession(this.properties.modelPath2, { executionProviders: onnxProviders });

		const cpuProviders = context.executionProviders.filter((ep) => ep !== "gpu");
		const fft = initFftBackend(cpuProviders.length > 0 ? cpuProviders : ["cpu"], this.properties);

		this.fftBackend = fft.backend;
		this.fftAddonOptions = fft.addonOptions;

		this.setupResampleComposition(context, DTLN_SAMPLE_RATE);
	}

	protected override async runMainPass(args: ModelPassArgs): Promise<void> {
		const { buffer, output, channels, originalFrames, bitDepth } = args;

		const streams: Array<DtlnBlockStream> = [];

		for (let channel = 0; channel < channels; channel++) {
			streams.push(
				new DtlnBlockStream({
					session1: this.session1,
					session2: this.session2,
					fftBackend: this.fftBackend,
					fftAddonOptions: this.fftAddonOptions,
				}),
			);
		}

		const stepAccum: Array<Float32Array> = [];

		for (let channel = 0; channel < channels; channel++) stepAccum.push(new Float32Array(BLOCK_SHIFT));

		let stepAccumLen = 0;

		const stepBatch: Array<Float32Array> = [];

		for (let channel = 0; channel < channels; channel++) stepBatch.push(new Float32Array(STEP_BATCH_SIZE));

		let stepBatchLen = 0;

		let samplesFed = 0;

		let warmupRemaining = WARMUP_SAMPLES;

		const writer = new BoundedWriter({
			output,
			sampleRate: DTLN_SAMPLE_RATE,
			bitDepth,
			totalFrames: originalFrames,
		});

		const progressGate = createProgressGate(originalFrames);

		for (;;) {
			const got16k = await pullModelChunk({ buffer, channels, frames: CHUNK_FRAMES });

			if (got16k === undefined) break;

			const firstChannel = got16k[0];
			const chunkFrames = firstChannel?.length ?? 0;

			if (chunkFrames === 0) break;

			let consumed = 0;

			while (consumed < chunkFrames) {
				const need = BLOCK_SHIFT - stepAccumLen;
				const take = Math.min(need, chunkFrames - consumed);

				for (let channel = 0; channel < channels; channel++) {
					const sourceChannel = got16k[channel] ?? firstChannel;
					const dest = stepAccum[channel];

					if (!sourceChannel || !dest) continue;

					dest.set(sourceChannel.subarray(consumed, consumed + take), stepAccumLen);
				}

				stepAccumLen += take;
				consumed += take;

				if (stepAccumLen === BLOCK_SHIFT) {
					const result = stepAllChannels({
						channels,
						streams,
						inputs: stepAccum,
						stepBatch,
						stepBatchLen,
						batchSize: STEP_BATCH_SIZE,
						warmupRemaining,
					});

					stepBatchLen = result.stepBatchLen;
					warmupRemaining = result.warmupRemaining;
					samplesFed += BLOCK_SHIFT;
					stepAccumLen = 0;

					if (stepBatchLen >= STEP_BATCH_SIZE) {
						await commitStepBatch({ stepBatch, length: stepBatchLen, channels, writer });
						stepBatchLen = 0;
					}
				}
			}

			const doneFrames = Math.min(samplesFed, originalFrames);

			if (progressGate(doneFrames, Date.now())) this.emitProgress("process", doneFrames, originalFrames);
		}

		if (samplesFed > 0 && samplesFed < BLOCK_LEN) {
			const zeroInputs: Array<Float32Array> = [];

			for (let channel = 0; channel < channels; channel++) zeroInputs.push(new Float32Array(BLOCK_SHIFT));

			while (samplesFed < BLOCK_LEN) {
				const result = stepAllChannels({
					channels,
					streams,
					inputs: zeroInputs,
					stepBatch,
					stepBatchLen,
					batchSize: STEP_BATCH_SIZE,
					warmupRemaining,
				});

				stepBatchLen = result.stepBatchLen;
				warmupRemaining = result.warmupRemaining;
				samplesFed += BLOCK_SHIFT;

				if (stepBatchLen >= STEP_BATCH_SIZE) {
					await commitStepBatch({ stepBatch, length: stepBatchLen, channels, writer });
					stepBatchLen = 0;
				}
			}
		}

		const flushOutputs: Array<Float32Array> = [];

		for (let channel = 0; channel < channels; channel++)
			flushOutputs.push(streams[channel]?.flush() ?? new Float32Array(0));

		const flushLen = flushOutputs[0]?.length ?? 0;

		if (flushLen > 0) {
			const result = appendToStepBatch({
				samples: flushOutputs,
				channels,
				stepBatch,
				stepBatchLen,
				batchSize: STEP_BATCH_SIZE,
				warmupRemaining,
			});

			stepBatchLen = result.stepBatchLen;
			warmupRemaining = result.warmupRemaining;

			if (stepBatchLen >= STEP_BATCH_SIZE) {
				await commitStepBatch({ stepBatch, length: stepBatchLen, channels, writer });
				stepBatchLen = 0;
			}
		}

		if (stepBatchLen > 0) {
			await commitStepBatch({ stepBatch, length: stepBatchLen, channels, writer });
			stepBatchLen = 0;
		}

		await writer.padTail(channels);
	}
}

export class DtlnNode extends TransformNode<DtlnProperties> {
	static override readonly nodeName = "DTLN (Denoiser)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Remove background noise from speech using DTLN neural network";
	static override readonly schema = schema;
	static override readonly Stream = DtlnStream;
}

export function dtln(options: {
	modelPath1: string;
	modelPath2: string;
	ffmpegPath: string;
	onnxAddonPath?: string;
	vkfftAddonPath?: string;
	fftwAddonPath?: string;
	id?: string;
}): DtlnNode {
	return new DtlnNode(options);
}
