import {
	BlockBuffer,
	BufferedTransformStream,
	createProgressGate,
	TransformNode,
	WHOLE_FILE,
	type Block,
	type StreamContext,
	type StreamSetupContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { initFftBackend, type FftBackend } from "@buffered-audio/utils";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { filterOnnxProviders } from "../../utils/onnx-providers";
import { createOnnxSession, type OnnxSession } from "../../utils/onnx-runtime";
import { createResampleComposition } from "../../utils/resample-composition";
import type { FfmpegStream } from "../ffmpeg";
import { BLOCK_LEN, BLOCK_SHIFT, DtlnBlockStream } from "./utils/dtln";
import { appendToStepBatch, CHUNK_FRAMES, commitStepBatch, DTLN_SAMPLE_RATE, padTail, pullNextChunkAt16k, STEP_BATCH_SIZE, stepAllChannels, WARMUP_SAMPLES } from "./utils/pump";

export const schema = z.object({
	modelPath1: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", accept: ".onnx", binary: "dtln-model_1", download: "https://github.com/breizhn/DTLN" })
		.describe("DTLN magnitude mask model (.onnx)"),
	modelPath2: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", accept: ".onnx", binary: "dtln-model_2", download: "https://github.com/breizhn/DTLN" })
		.describe("DTLN time-domain model (.onnx)"),
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
	onnxAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "onnx-addon", download: "https://github.com/visionsofparadise/onnx-runtime-addon" })
		.describe("ONNX Runtime native addon"),
	vkfftAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "vkfft-addon", download: "https://github.com/visionsofparadise/vkfft-addon" })
		.describe("VkFFT native addon — GPU FFT acceleration"),
	fftwAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "fftw-addon", download: "https://github.com/visionsofparadise/fftw-addon" })
		.describe("FFTW native addon — CPU FFT acceleration"),
});

export interface DtlnProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class DtlnStream extends BufferedTransformStream<DtlnNode> {
	override blockSize = WHOLE_FILE;

	private session1!: OnnxSession;
	private session2!: OnnxSession;
	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	private readonly renderContext: StreamContext;
	private upResample?: FfmpegStream;
	private downResample?: FfmpegStream;

	constructor(node: DtlnNode, context: StreamContext) {
		super(node, context);

		this.renderContext = context;
	}

	override _setup(context: StreamSetupContext): void {
		const onnxProviders = filterOnnxProviders(context.executionProviders);

		this.session1 = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath1, { executionProviders: onnxProviders }, (message, data) => this.log(message, data));
		this.session2 = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath2, { executionProviders: onnxProviders }, (message, data) => this.log(message, data));

		const cpuProviders = context.executionProviders.filter((ep) => ep !== "gpu");
		const fft = initFftBackend(cpuProviders.length > 0 ? cpuProviders : ["cpu"], this.properties);

		this.fftBackend = fft.backend;
		this.fftAddonOptions = fft.addonOptions;

		const composition = createResampleComposition({ context, streamContext: this.renderContext, ffmpegPath: this.properties.ffmpegPath, modelRate: DTLN_SAMPLE_RATE });

		if (composition) {
			this.upResample = composition.upResample;
			this.downResample = composition.downResample;
		}
	}

	override _pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		if (!this.upResample || !this.downResample) return super._pipe(input);

		return this.downResample._pipe(super._pipe(this.upResample._pipe(input)));
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const originalFrames = buffered.frames;
		const channels = buffered.channels;

		if (originalFrames === 0 || channels === 0) return;

		const bitDepth = this.bitDepth;

		await buffered.reset();

		const output = new BlockBuffer();

		try {
			await this.runMainPass({
				buffer: buffered,
				output,
				channels,
				originalFrames,
				bitDepth,
			});

			await output.reset();

			yield* output.iterate(CHUNK_FRAMES);
		} finally {
			await output.close();
		}
	}

	private async runMainPass(args: {
		readonly buffer: BlockBuffer;
		readonly output: BlockBuffer;
		readonly channels: number;
		readonly originalFrames: number;
		readonly bitDepth: number | undefined;
	}): Promise<void> {
		const { buffer, output, channels, originalFrames, bitDepth } = args;

		// Per-channel DTLN streaming state. LSTM states are per-channel; the OLA
		// scratch and sliding input window are per-channel.
		const streams: Array<DtlnBlockStream> = [];

		for (let channel = 0; channel < channels; channel++) {
			streams.push(new DtlnBlockStream({ session1: this.session1, session2: this.session2, fftBackend: this.fftBackend, fftAddonOptions: this.fftAddonOptions }));
		}

		const stepAccum: Array<Float32Array> = [];

		for (let channel = 0; channel < channels; channel++) stepAccum.push(new Float32Array(BLOCK_SHIFT));
		let stepAccumLen = 0;

		const stepBatch: Array<Float32Array> = [];

		for (let channel = 0; channel < channels; channel++) stepBatch.push(new Float32Array(STEP_BATCH_SIZE));
		let stepBatchLen = 0;

		let samplesFed = 0;

		let warmupRemaining = WARMUP_SAMPLES;

		const writerState = { written: 0 };

		const progressGate = createProgressGate(originalFrames);

		for (;;) {
			const got16k = await pullNextChunkAt16k({ buffer, channels, frames: CHUNK_FRAMES });

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
					const result = stepAllChannels({ channels, streams, inputs: stepAccum, stepBatch, stepBatchLen, batchSize: STEP_BATCH_SIZE, warmupRemaining });

					stepBatchLen = result.stepBatchLen;
					warmupRemaining = result.warmupRemaining;
					samplesFed += BLOCK_SHIFT;
					stepAccumLen = 0;

					if (stepBatchLen >= STEP_BATCH_SIZE) {
						await commitStepBatch({ stepBatch, length: stepBatchLen, channels, output, sampleRate: DTLN_SAMPLE_RATE, bitDepth, originalFrames, writerState });
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
				const result = stepAllChannels({ channels, streams, inputs: zeroInputs, stepBatch, stepBatchLen, batchSize: STEP_BATCH_SIZE, warmupRemaining });

				stepBatchLen = result.stepBatchLen;
				warmupRemaining = result.warmupRemaining;
				samplesFed += BLOCK_SHIFT;

				if (stepBatchLen >= STEP_BATCH_SIZE) {
					await commitStepBatch({ stepBatch, length: stepBatchLen, channels, output, sampleRate: DTLN_SAMPLE_RATE, bitDepth, originalFrames, writerState });
					stepBatchLen = 0;
				}
			}
		}

		// flush() returns the trailing BLOCK_LEN - BLOCK_SHIFT = 384 samples per channel.
		const flushOutputs: Array<Float32Array> = [];

		for (let channel = 0; channel < channels; channel++) flushOutputs.push(streams[channel]?.flush() ?? new Float32Array(0));

		const flushLen = flushOutputs[0]?.length ?? 0;

		if (flushLen > 0) {
			const result = appendToStepBatch({ samples: flushOutputs, channels, stepBatch, stepBatchLen, batchSize: STEP_BATCH_SIZE, warmupRemaining });

			stepBatchLen = result.stepBatchLen;
			warmupRemaining = result.warmupRemaining;

			if (stepBatchLen >= STEP_BATCH_SIZE) {
				await commitStepBatch({ stepBatch, length: stepBatchLen, channels, output, sampleRate: DTLN_SAMPLE_RATE, bitDepth, originalFrames, writerState });
				stepBatchLen = 0;
			}
		}

		if (stepBatchLen > 0) {
			await commitStepBatch({ stepBatch, length: stepBatchLen, channels, output, sampleRate: DTLN_SAMPLE_RATE, bitDepth, originalFrames, writerState });
			stepBatchLen = 0;
		}

		// Zero-pad: warm-up trimming can leave written < originalFrames.
		await padTail(output, channels, originalFrames, writerState.written, DTLN_SAMPLE_RATE, bitDepth);
	}
}

export class DtlnNode extends TransformNode<DtlnProperties> {
	static override readonly nodeName = "DTLN (Denoiser)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Remove background noise from speech using DTLN neural network";
	static override readonly schema = schema;
	static override readonly Stream = DtlnStream;
}

export function dtln(options: { modelPath1: string; modelPath2: string; ffmpegPath: string; onnxAddonPath?: string; vkfftAddonPath?: string; fftwAddonPath?: string; id?: string }): DtlnNode {
	return new DtlnNode(options);
}
