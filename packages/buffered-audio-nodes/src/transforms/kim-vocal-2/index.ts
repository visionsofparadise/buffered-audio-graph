import { z } from "zod";
import { BufferedTransformStream, ChunkBuffer, TransformNode, WHOLE_FILE, type AudioChunk, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { bandpass, MixedRadixFft, ResampleStream } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { filterOnnxProviders } from "../../utils/onnx-providers";
import { createOnnxSession, type OnnxSession } from "../../utils/onnx-runtime";
import { buildTransitionWindow, createSegmentWorkspace, processSegment } from "./utils/segment";

export const schema = z.object({
	modelPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", accept: ".onnx", binary: "Kim_Vocal_2", download: "https://huggingface.co/seanghay/uvr_models" })
		.describe("MDX-Net vocal isolation model (.onnx)"),
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
	onnxAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "onnx-addon", download: "https://github.com/visionsofparadise/onnx-runtime-addon" })
		.describe("ONNX Runtime native addon"),
	highPass: z.number().min(20).max(500).multipleOf(10).default(80).describe("High Pass"),
	lowPass: z.number().min(1000).max(22050).multipleOf(100).default(20000).describe("Low Pass"),
});

export interface KimVocal2Properties extends z.infer<typeof schema>, TransformNodeProperties {}

const SAMPLE_RATE = 44100;
const N_FFT = 7680;
const HOP_SIZE = 1024;
const DIM_T = 256;
const COMPENSATE = 1.009;
const SEGMENT_SAMPLES = N_FFT + (DIM_T - 1) * HOP_SIZE; // 268800
const OVERLAP = 0.25;
const TRANSITION_POWER = 1.0;

const CHUNK_FRAMES = 44100; // 44.1 kHz input-side chunk
const RESAMPLE_DRAIN_CHUNK = 16384;

interface StreamPair {
	readonly resampleIn: ResampleStream;
	readonly resampleOut: ResampleStream;
}

export class KimVocal2Stream extends BufferedTransformStream<KimVocal2Properties> {
	private session!: OnnxSession;
	private fftInstance: MixedRadixFft;

	constructor(properties: KimVocal2Properties) {
		super(properties);
		this.fftInstance = new MixedRadixFft(N_FFT);
	}

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<ReadableStream<AudioChunk>> {
		this.session = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath, { executionProviders: filterOnnxProviders(context.executionProviders) }, (message, data) => this.log(message, data));

		return super._setup(input, context);
	}

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const originalFrames = buffer.frames;
		const channels = buffer.channels;

		if (originalFrames === 0 || channels === 0) return;

		const sourceRate = this.sampleRate ?? SAMPLE_RATE;
		const bitDepth = this.bitDepth;
		const needsResample = sourceRate !== SAMPLE_RATE;

		await buffer.reset();

		let pair: StreamPair | undefined;

		if (needsResample) {
			pair = {
				resampleIn: new ResampleStream(this.properties.ffmpegPath, {
					sourceSampleRate: sourceRate,
					targetSampleRate: SAMPLE_RATE,
					channels: 2,
				}),
				resampleOut: new ResampleStream(this.properties.ffmpegPath, {
					sourceSampleRate: SAMPLE_RATE,
					targetSampleRate: sourceRate,
					channels: 2,
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
		const stride = Math.round((1 - OVERLAP) * SEGMENT_SAMPLES);
		const isMono = channels < 2;

		const writerState = { written: 0 };
		const pumpDone = pair !== undefined ? pumpSourceToResampleIn({ buffer, resampleIn: pair.resampleIn, channels, chunkFrames: CHUNK_FRAMES }) : Promise.resolve();
		const drainerDone = pair !== undefined ? drainResampleOutToBuffer({ resampleOut: pair.resampleOut, output, channels, sourceRate, bitDepth, originalFrames, writerState }) : Promise.resolve();

		// OLA weight window: triangular raised to TRANSITION_POWER.
		const weight = buildTransitionWindow(SEGMENT_SAMPLES, TRANSITION_POWER);

		const workspace = createSegmentWorkspace(SEGMENT_SAMPLES);

		const segLeft = new Float32Array(SEGMENT_SAMPLES);
		const segRight = new Float32Array(SEGMENT_SAMPLES);
		let segFilled = 0;
		let inputExhausted = false;

		// kim-vocal-2 is a single-stem vocal separator (vs. htdemucs's 4 stems), so one OLA accumulator pair.
		const outAccumLeft = new Float32Array(SEGMENT_SAMPLES);
		const outAccumRight = new Float32Array(SEGMENT_SAMPLES);
		const sumWeight = new Float32Array(SEGMENT_SAMPLES);

		for (;;) {
			if (!inputExhausted) {
				while (segFilled < SEGMENT_SAMPLES) {
					const need = SEGMENT_SAMPLES - segFilled;
					const got = await pullNextChunkAt441({ buffer, pair, channels, frames: Math.min(need, CHUNK_FRAMES) });

					if (got === undefined || got[0].length === 0) {
						inputExhausted = true;
						break;
					}

					const left = got[0];
					const right = got[1];
					const frames = left.length;

					for (let index = 0; index < frames; index++) {
						segLeft[segFilled + index] = left[index] ?? 0;
						segRight[segFilled + index] = right[index] ?? 0;
					}

					segFilled += frames;
				}
			}

			if (segFilled === 0) break;

			const chunkLength = segFilled;
			const processed = processSegment(segLeft, segRight, 0, chunkLength, isMono, workspace, this.fftInstance, this.session, COMPENSATE);

			const isFinalIter = inputExhausted;
			const nStable = isFinalIter ? chunkLength : stride;

			if (processed) {
				for (let index = 0; index < chunkLength; index++) {
					const wt = weight[index] ?? 1;

					outAccumLeft[index] = (outAccumLeft[index] ?? 0) + (processed.left[index] ?? 0) * wt;
					outAccumRight[index] = (outAccumRight[index] ?? 0) + (processed.right[index] ?? 0) * wt;
					sumWeight[index] = (sumWeight[index] ?? 0) + wt;
				}
			} else {
				// Rare no-model-output case: mirror the original's `continue` (no weight added) to preserve OLA division semantics.
			}

			await this.emitStable({
				nStable,
				outAccumLeft,
				outAccumRight,
				sumWeight,
				pair,
				output,
				channels,
				sourceRate,
				bitDepth,
				originalFrames,
				writerState,
			});

			if (!isFinalIter) {
				segLeft.copyWithin(0, nStable, SEGMENT_SAMPLES);
				segRight.copyWithin(0, nStable, SEGMENT_SAMPLES);
				segLeft.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
				segRight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
				segFilled = SEGMENT_SAMPLES - nStable;
			} else {
				break;
			}
		}

		// Await defensively to surface pump-side errors.
		await pumpDone;

		if (pair) {
			await pair.resampleOut.end();
		}

		await drainerDone;

		// Zero-pad when rate conversion produced fewer frames than the original.
		await padTail(output, channels, originalFrames, writerState.written, sourceRate, bitDepth);
	}

	private async emitStable(args: {
		readonly nStable: number;
		readonly outAccumLeft: Float32Array;
		readonly outAccumRight: Float32Array;
		readonly sumWeight: Float32Array;
		readonly pair: StreamPair | undefined;
		readonly output: ChunkBuffer;
		readonly channels: number;
		readonly sourceRate: number;
		readonly bitDepth: number | undefined;
		readonly originalFrames: number;
		readonly writerState: { written: number };
	}): Promise<void> {
		const { nStable, outAccumLeft, outAccumRight, sumWeight, pair, output, channels, sourceRate, bitDepth, originalFrames, writerState } = args;

		if (nStable <= 0) return;

		const outLeft = new Float32Array(nStable);
		const outRight = new Float32Array(nStable);

		for (let index = 0; index < nStable; index++) {
			const sw = sumWeight[index] ?? 1;

			outLeft[index] = sw > 0 ? (outAccumLeft[index] ?? 0) / sw : (outAccumLeft[index] ?? 0);
			outRight[index] = sw > 0 ? (outAccumRight[index] ?? 0) / sw : (outAccumRight[index] ?? 0);
		}

		bandpass([outLeft, outRight], SAMPLE_RATE, this.properties.highPass, this.properties.lowPass);

		if (pair) {
			await pair.resampleOut.write([outLeft, outRight]);
		} else {
			const writeChannels = buildWriteChannels(outLeft, outRight, channels);
			const remaining = Math.max(0, originalFrames - writerState.written);

			if (remaining > 0) {
				const take = Math.min(nStable, remaining);
				const sliced = take === nStable ? writeChannels : writeChannels.map((channel) => channel.subarray(0, take));

				await output.write(sliced, sourceRate, bitDepth);
				writerState.written += take;
			}
		}

		outAccumLeft.copyWithin(0, nStable, SEGMENT_SAMPLES);
		outAccumLeft.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
		outAccumRight.copyWithin(0, nStable, SEGMENT_SAMPLES);
		outAccumRight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
		sumWeight.copyWithin(0, nStable, SEGMENT_SAMPLES);
		sumWeight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
	}
}

// === Helpers ===

async function pullNextChunkAt441(args: {
	readonly buffer: ChunkBuffer;
	readonly pair: StreamPair | undefined;
	readonly channels: number;
	readonly frames: number;
}): Promise<readonly [Float32Array, Float32Array] | undefined> {
	const { buffer, pair, channels, frames } = args;

	if (!pair) {
		const chunk = await buffer.read(frames);
		const got = chunk.samples[0]?.length ?? 0;

		if (got === 0) return undefined;

		const left = chunk.samples[0] ?? new Float32Array(got);
		const right = channels >= 2 ? (chunk.samples[1] ?? left) : left;

		return [left, right];
	}

	const out = await pair.resampleIn.read(frames);
	const got = out[0]?.length ?? 0;

	if (got === 0) return undefined;

	const left = out[0] ?? new Float32Array(got);
	const right = out[1] ?? left;

	return [left, right];
}

// Resampler always spawned channels:2; mono duplicated to right so the segment loop sees stable stereo.
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

		const sourceLeft = sourceChunk.samples[0] ?? new Float32Array(sourceFrames);
		const sourceRight = channels >= 2 ? (sourceChunk.samples[1] ?? sourceLeft) : sourceLeft;

		await resampleIn.write([sourceLeft, sourceRight]);

		if (sourceFrames < chunkFrames) break;
	}

	await resampleIn.end();
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
	const right = chunk[1] ?? firstChannel;
	const writeLeft = take === got ? firstChannel : firstChannel.subarray(0, take);
	const writeRight = take === got ? right : right.subarray(0, take);

	const writeChannels = buildWriteChannels(writeLeft, writeRight, channels);

	await output.write(writeChannels, sourceRate, bitDepth);
	writerState.written += take;
}

function buildWriteChannels(left: Float32Array, right: Float32Array, channels: number): Array<Float32Array> {
	const out: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		if (channel === 0) out.push(left);
		else if (channel === 1) out.push(right);
		else out.push(left);
	}

	return out;
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

export class KimVocal2Node extends TransformNode<KimVocal2Properties> {
	static override readonly nodeName = "Kim Vocal 2 (Stem Separator)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Isolate dialogue from background using MDX-Net vocal separation";
	static override readonly schema = schema;

	static override is(value: unknown): value is KimVocal2Node {
		return TransformNode.is(value) && value.type[2] === "kim-vocal-2";
	}

	override readonly type = ["buffered-audio-node", "transform", "kim-vocal-2"] as const;

	constructor(properties: KimVocal2Properties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): KimVocal2Stream {
		return new KimVocal2Stream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<KimVocal2Properties>): KimVocal2Node {
		return new KimVocal2Node({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function kimVocal2(options: { modelPath: string; ffmpegPath: string; onnxAddonPath?: string; highPass?: number; lowPass?: number; id?: string }): KimVocal2Node {
	return new KimVocal2Node({
		modelPath: options.modelPath,
		ffmpegPath: options.ffmpegPath,
		onnxAddonPath: options.onnxAddonPath ?? "",
		highPass: options.highPass ?? 80,
		lowPass: options.lowPass ?? 20000,
		id: options.id,
	});
}
