import { z } from "zod";
import { BufferedTransformStream, BlockBuffer, TransformNode, WHOLE_FILE, type Block, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { initFftBackend, ResampleStream, type FftBackend } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { filterOnnxProviders } from "../../utils/onnx-providers";
import { createOnnxSession, type OnnxSession } from "../../utils/onnx-runtime";
import { BLOCK_LEN, BLOCK_SHIFT, DtlnBlockStream } from "./utils/dtln";
import {
	appendToStepBatch,
	commitStepBatch,
	CHUNK_FRAMES,
	DTLN_SAMPLE_RATE,
	drainResampleOutToBuffer,
	padTail,
	pullNextChunkAt16k,
	pumpSourceToResampleIn,
	stepAllChannels,
	STEP_BATCH_SIZE,
	WARMUP_SAMPLES,
	type StreamPair,
} from "./utils/pump";

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

export class DtlnStream extends BufferedTransformStream<DtlnProperties> {
	override blockSize = WHOLE_FILE;

	private session1!: OnnxSession;
	private session2!: OnnxSession;
	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };

	override async _setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		const onnxProviders = filterOnnxProviders(context.executionProviders);

		this.session1 = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath1, { executionProviders: onnxProviders }, (message, data) => this.log(message, data));
		this.session2 = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath2, { executionProviders: onnxProviders }, (message, data) => this.log(message, data));

		const cpuProviders = context.executionProviders.filter((ep) => ep !== "gpu");
		const fft = initFftBackend(cpuProviders.length > 0 ? cpuProviders : ["cpu"], this.properties);

		this.fftBackend = fft.backend;
		this.fftAddonOptions = fft.addonOptions;

		return super._setup(input, context);
	}

	override async transform(buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
		const originalFrames = buffered.frames;
		const channels = buffered.channels;

		if (originalFrames === 0 || channels === 0) return;

		const sourceRate = this.sampleRate ?? DTLN_SAMPLE_RATE;
		const bitDepth = this.bitDepth;
		const needsResample = sourceRate !== DTLN_SAMPLE_RATE;

		await buffered.reset();

		let pair: StreamPair | undefined;

		if (needsResample) {
			pair = {
				resampleIn: new ResampleStream(this.properties.ffmpegPath, {
					sourceSampleRate: sourceRate,
					targetSampleRate: DTLN_SAMPLE_RATE,
					channels,
				}),
				resampleOut: new ResampleStream(this.properties.ffmpegPath, {
					sourceSampleRate: DTLN_SAMPLE_RATE,
					targetSampleRate: sourceRate,
					channels,
				}),
			};
		}

		const output = new BlockBuffer();

		try {
			await this.runMainPass({
				buffer: buffered,
				output,
				channels,
				originalFrames,
				sourceRate,
				bitDepth,
				pair,
			});

			await output.reset();

			for await (const block of output.iterate(CHUNK_FRAMES)) {
				enqueue(block);
			}
		} finally {
			if (pair) {
				await Promise.all([pair.resampleIn.close(), pair.resampleOut.close()]);
			}

			await output.close();
		}
	}

	private async runMainPass(args: {
		readonly buffer: BlockBuffer;
		readonly output: BlockBuffer;
		readonly channels: number;
		readonly originalFrames: number;
		readonly sourceRate: number;
		readonly bitDepth: number | undefined;
		readonly pair: StreamPair | undefined;
	}): Promise<void> {
		const { buffer, output, channels, originalFrames, sourceRate, bitDepth, pair } = args;

		// Per-channel DTLN streaming state. LSTM states are per-channel; the OLA
		// scratch and sliding input window are per-channel.
		const streams: Array<DtlnBlockStream> = [];

		for (let ch = 0; ch < channels; ch++) {
			streams.push(new DtlnBlockStream({ session1: this.session1, session2: this.session2, fftBackend: this.fftBackend, fftAddonOptions: this.fftAddonOptions }));
		}

		const stepAccum: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) stepAccum.push(new Float32Array(BLOCK_SHIFT));
		let stepAccumLen = 0;

		const stepBatch: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) stepBatch.push(new Float32Array(STEP_BATCH_SIZE));
		let stepBatchLen = 0;

		let samplesFed = 0;

		let warmupRemaining = WARMUP_SAMPLES;

		const writerState = { written: 0 };

		const pumpDone = pair !== undefined ? pumpSourceToResampleIn({ buffer, resampleIn: pair.resampleIn, channels, chunkFrames: CHUNK_FRAMES }) : Promise.resolve();
		const drainerDone = pair !== undefined ? drainResampleOutToBuffer({ resampleOut: pair.resampleOut, output, channels, sourceRate, bitDepth, originalFrames, writerState }) : Promise.resolve();

		for (;;) {
			const got16k = await pullNextChunkAt16k({ buffer, pair, channels, frames: CHUNK_FRAMES });

			if (got16k === undefined) break;

			const firstChannel = got16k[0];
			const chunkFrames = firstChannel?.length ?? 0;

			if (chunkFrames === 0) break;

			let consumed = 0;

			while (consumed < chunkFrames) {
				const need = BLOCK_SHIFT - stepAccumLen;
				const take = Math.min(need, chunkFrames - consumed);

				for (let ch = 0; ch < channels; ch++) {
					const src = got16k[ch] ?? firstChannel;
					const dest = stepAccum[ch];

					if (!src || !dest) continue;
					dest.set(src.subarray(consumed, consumed + take), stepAccumLen);
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
						await commitStepBatch({ stepBatch, length: stepBatchLen, channels, pair, output, sourceRate, bitDepth, originalFrames, writerState });
						stepBatchLen = 0;
					}
				}
			}
		}

		// Await defensively to surface pump-side errors.
		await pumpDone;

		if (samplesFed > 0 && samplesFed < BLOCK_LEN) {
			const zeroInputs: Array<Float32Array> = [];

			for (let ch = 0; ch < channels; ch++) zeroInputs.push(new Float32Array(BLOCK_SHIFT));

			while (samplesFed < BLOCK_LEN) {
				const result = stepAllChannels({ channels, streams, inputs: zeroInputs, stepBatch, stepBatchLen, batchSize: STEP_BATCH_SIZE, warmupRemaining });

				stepBatchLen = result.stepBatchLen;
				warmupRemaining = result.warmupRemaining;
				samplesFed += BLOCK_SHIFT;

				if (stepBatchLen >= STEP_BATCH_SIZE) {
					await commitStepBatch({ stepBatch, length: stepBatchLen, channels, pair, output, sourceRate, bitDepth, originalFrames, writerState });
					stepBatchLen = 0;
				}
			}
		}

		// flush() returns the trailing BLOCK_LEN - BLOCK_SHIFT = 384 samples per channel.
		const flushOutputs: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) flushOutputs.push(streams[ch]?.flush() ?? new Float32Array(0));

		const flushLen = flushOutputs[0]?.length ?? 0;

		if (flushLen > 0) {
			const result = appendToStepBatch({ samples: flushOutputs, channels, stepBatch, stepBatchLen, batchSize: STEP_BATCH_SIZE, warmupRemaining });

			stepBatchLen = result.stepBatchLen;
			warmupRemaining = result.warmupRemaining;

			if (stepBatchLen >= STEP_BATCH_SIZE) {
				await commitStepBatch({ stepBatch, length: stepBatchLen, channels, pair, output, sourceRate, bitDepth, originalFrames, writerState });
				stepBatchLen = 0;
			}
		}

		if (stepBatchLen > 0) {
			await commitStepBatch({ stepBatch, length: stepBatchLen, channels, pair, output, sourceRate, bitDepth, originalFrames, writerState });
			stepBatchLen = 0;
		}

		if (pair) {
			await pair.resampleOut.end();
		}

		await drainerDone;

		// Zero-pad: rate-conversion rounding can leave written < originalFrames.
		await padTail(output, channels, originalFrames, writerState.written, sourceRate, bitDepth);
	}
}

export class DtlnNode extends TransformNode<DtlnProperties> {
	static override readonly nodeName = "DTLN (Denoiser)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Remove background noise from speech using DTLN neural network";
	static override readonly schema = schema;
	static override readonly streamClass = DtlnStream;
	static override is(value: unknown): value is DtlnNode {
		return TransformNode.is(value) && value.type[2] === "dtln";
	}

	override readonly type = ["buffered-audio-node", "transform", "dtln"] as const;

	override clone(overrides?: Partial<DtlnProperties>): DtlnNode {
		return new DtlnNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
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
