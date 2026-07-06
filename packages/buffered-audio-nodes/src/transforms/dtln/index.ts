import { z } from "zod";
import { BufferedTransformStream, ChunkBuffer, TransformNode, WHOLE_FILE, type AudioChunk, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { initFftBackend, ResampleStream, type FftBackend } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { filterOnnxProviders } from "../../utils/onnx-providers";
import { createOnnxSession, type OnnxSession } from "../../utils/onnx-runtime";
import { BLOCK_LEN, BLOCK_SHIFT, DtlnBlockStream, WARMUP_SHIFTS } from "./utils/dtln";

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

const DTLN_SAMPLE_RATE = 16000;
const CHUNK_FRAMES = 16000; // 1 s at 16 kHz
const RESAMPLE_DRAIN_CHUNK = 16384;
const STEP_BATCH_SIZE = 16000; // ~125 BLOCK_SHIFTs
const WARMUP_SAMPLES = WARMUP_SHIFTS * BLOCK_SHIFT; // 384

interface StreamPair {
	readonly resampleIn: ResampleStream;
	readonly resampleOut: ResampleStream;
}

export class DtlnStream extends BufferedTransformStream<DtlnProperties> {
	private session1!: OnnxSession;
	private session2!: OnnxSession;
	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<ReadableStream<AudioChunk>> {
		const onnxProviders = filterOnnxProviders(context.executionProviders);

		this.session1 = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath1, { executionProviders: onnxProviders }, (message, data) => this.log(message, data));
		this.session2 = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath2, { executionProviders: onnxProviders }, (message, data) => this.log(message, data));

		const cpuProviders = context.executionProviders.filter((ep) => ep !== "gpu");
		const fft = initFftBackend(cpuProviders.length > 0 ? cpuProviders : ["cpu"], this.properties);

		this.fftBackend = fft.backend;
		this.fftAddonOptions = fft.addonOptions;

		return super._setup(input, context);
	}

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const originalFrames = buffer.frames;
		const channels = buffer.channels;

		if (originalFrames === 0 || channels === 0) return;

		const sourceRate = this.sampleRate ?? DTLN_SAMPLE_RATE;
		const bitDepth = this.bitDepth;
		const needsResample = sourceRate !== DTLN_SAMPLE_RATE;

		await buffer.reset();

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

		const output = new ChunkBuffer();

		try {
			await this.runMainPass({
				buffer,
				output,
				channels,
				originalFrames,
				sourceRate,
				bitDepth,
				pair,
			});

			await buffer.clear();
			await output.reset();

			for (;;) {
				const chunk = await output.read(CHUNK_FRAMES);
				const got = chunk.samples[0]?.length ?? 0;

				if (got === 0) break;

				await buffer.write(chunk.samples, sourceRate, bitDepth);

				if (got < CHUNK_FRAMES) break;
			}
		} finally {
			if (pair) {
				await Promise.all([pair.resampleIn.close(), pair.resampleOut.close()]);
			}

			await output.close();
		}
	}

	private async runMainPass(args: {
		readonly buffer: ChunkBuffer;
		readonly output: ChunkBuffer;
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

// === Helpers ===

function stepAllChannels(args: {
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

function appendToStepBatch(args: {
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

async function commitStepBatch(args: {
	readonly stepBatch: ReadonlyArray<Float32Array>;
	readonly length: number;
	readonly channels: number;
	readonly pair: StreamPair | undefined;
	readonly output: ChunkBuffer;
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

async function drainResampleOutToBuffer(args: {
	readonly resampleOut: ResampleStream;
	readonly output: ChunkBuffer;
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

async function pullNextChunkAt16k(args: {
	readonly buffer: ChunkBuffer;
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

async function pumpSourceToResampleIn(args: {
	readonly buffer: ChunkBuffer;
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

async function commitResampledFrames(args: {
	readonly chunk: ReadonlyArray<Float32Array>;
	readonly channels: number;
	readonly output: ChunkBuffer;
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

async function padTail(output: ChunkBuffer, channels: number, originalFrames: number, written: number, sourceRate: number, bitDepth: number | undefined): Promise<void> {
	if (written >= originalFrames) return;

	const missing = originalFrames - written;
	const padChannels: Array<Float32Array> = [];

	for (let channel = 0; channel < Math.max(1, channels); channel++) {
		padChannels.push(new Float32Array(missing));
	}

	await output.write(padChannels, sourceRate, bitDepth);
}

export class DtlnNode extends TransformNode<DtlnProperties> {
	static override readonly nodeName = "DTLN (Denoiser)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Remove background noise from speech using DTLN neural network";
	static override readonly schema = schema;
	static override is(value: unknown): value is DtlnNode {
		return TransformNode.is(value) && value.type[2] === "dtln";
	}

	override readonly type = ["buffered-audio-node", "transform", "dtln"] as const;

	constructor(properties: DtlnProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): DtlnStream {
		return new DtlnStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

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
	return new DtlnNode({
		modelPath1: options.modelPath1,
		modelPath2: options.modelPath2,
		ffmpegPath: options.ffmpegPath,
		onnxAddonPath: options.onnxAddonPath ?? "",
		vkfftAddonPath: options.vkfftAddonPath ?? "",
		fftwAddonPath: options.fftwAddonPath ?? "",
		id: options.id,
	});
}
