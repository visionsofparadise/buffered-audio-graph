import { z } from "zod";
import { BufferedTransformStream, BlockBuffer, createProgressGate, TransformNode, WHOLE_FILE, type Block, type StreamContext, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { bandpass } from "@buffered-audio/utils";
import { PACKAGE_NAME } from "../../package-metadata";
import { createOnnxSession, type OnnxSession } from "../../utils/onnx-runtime";
import { createResampleComposition } from "../../utils/resample-composition";
import type { FfmpegStream } from "../ffmpeg";
import { buildTriangularWeight, computeStftScaled, reflectPad } from "./utils/dsp";
import { buildModelInput, extractStems, mixStemsToStereo, type StftWorkspace } from "./utils/stems";

export interface StemGains {
	readonly vocals: number;
	readonly drums: number;
	readonly bass: number;
	readonly other: number;
}

export const schema = z.object({
	modelPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", accept: ".onnx", binary: "htdemucs", download: "https://github.com/facebookresearch/demucs" })
		.describe("HTDemucs source separation model (.onnx) — requires .onnx.data file alongside"),
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
	onnxAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "onnx-addon", download: "https://github.com/visionsofparadise/onnx-runtime-addon" })
		.describe("ONNX Runtime native addon"),
	highPass: z.number().min(0).max(500).multipleOf(10).default(0).describe("High Pass"),
	lowPass: z.number().min(0).max(22050).multipleOf(100).default(0).describe("Low Pass"),
});

export interface HtdemucsProperties extends z.infer<typeof schema>, TransformNodeProperties {
	readonly stems: StemGains;
}

const HTDEMUCS_SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;
const HOP_SIZE = 1024;
const SEGMENT_SAMPLES = 343980; // 7.8s at 44100Hz
const OVERLAP = 0.25;
const TRANSITION_POWER = 1.0;
const CHUNK_FRAMES = 44100; // 44.1 kHz native rate
const STEM_OUTPUTS = 4 * 2;

export class HtdemucsStream extends BufferedTransformStream<HtdemucsNode> {
	override blockSize = WHOLE_FILE;

	private session!: OnnxSession;
	private readonly renderContext: StreamContext;
	private upResample?: FfmpegStream;
	private downResample?: FfmpegStream;

	constructor(node: HtdemucsNode, context: StreamContext) {
		super(node, context);

		this.renderContext = context;
	}

	override _setup(context: StreamSetupContext): void {
		// CPU-only: DML session-create throw; see design-onnx-providers.
		this.session = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath, { executionProviders: ["cpu"] }, (message, data) => this.log(message, data));

		const composition = createResampleComposition({ context, streamContext: this.renderContext, ffmpegPath: this.properties.ffmpegPath, modelRate: HTDEMUCS_SAMPLE_RATE });

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

		const stats = await computeStreamingStats(buffered, channels);

		this.log("streaming stats computed", { mean: stats.mean, std: stats.std });

		await buffered.reset();

		const output = new BlockBuffer();

		try {
			await this.runMainPass({
				buffer: buffered,
				output,
				channels,
				originalFrames,
				bitDepth,
				stats,
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
		readonly stats: { readonly mean: number; readonly std: number };
	}): Promise<void> {
		const { buffer, output, channels, originalFrames, bitDepth, stats } = args;
		const stride = Math.round((1 - OVERLAP) * SEGMENT_SAMPLES);

		const writerState = { written: 0 };

		// OLA weight window: triangular raised to TRANSITION_POWER.
		const weight = buildTriangularWeight(SEGMENT_SAMPLES, TRANSITION_POWER);

		const pad = Math.floor(HOP_SIZE / 2) * 3; // 1536
		const le = Math.ceil(SEGMENT_SAMPLES / HOP_SIZE);
		const padEnd = pad + le * HOP_SIZE - SEGMENT_SAMPLES;
		const paddedLen = SEGMENT_SAMPLES + pad + padEnd;
		const stftPadConst = FFT_SIZE / 2;
		const stftLenConst = paddedLen + FFT_SIZE;
		const nbBinsConst = FFT_SIZE / 2 + 1;
		const nbFramesConst = Math.floor((stftLenConst - FFT_SIZE) / HOP_SIZE) + 1;
		const xBinsConst = nbBinsConst - 1;
		const xFramesConst = nbFramesConst - 4;

		const freqRealBuffers: Array<Float32Array> = [];
		const freqImagBuffers: Array<Float32Array> = [];

		for (let frame = 0; frame < nbFramesConst; frame++) {
			freqRealBuffers.push(new Float32Array(nbBinsConst));
			freqImagBuffers.push(new Float32Array(nbBinsConst));
		}

		const workspace: StftWorkspace = {
			freqRealBuffers,
			freqImagBuffers,
			nbFrames: nbFramesConst,
			stftLen: stftLenConst,
			stftPad: stftPadConst,
			pad,
			xBins: xBinsConst,
			xFrames: xFramesConst,
		};

		const segLeft = new Float32Array(SEGMENT_SAMPLES);
		const segRight = new Float32Array(SEGMENT_SAMPLES);
		let segFilled = 0;
		let inputExhausted = false;

		const stemAccum: Array<Float32Array> = [];

		for (let stem = 0; stem < STEM_OUTPUTS; stem++) stemAccum.push(new Float32Array(SEGMENT_SAMPLES));
		const sumWeight = new Float32Array(SEGMENT_SAMPLES);

		const { stems } = this.properties;
		const stemGains = [stems.drums, stems.bass, stems.other, stems.vocals];

		const inv = 1 / (stats.std || 1);

		const progressGate = createProgressGate(originalFrames);
		let stableEmitted = 0;

		for (;;) {
			if (!inputExhausted) {
				while (segFilled < SEGMENT_SAMPLES) {
					const need = SEGMENT_SAMPLES - segFilled;
					const got = await pullNextChunkAt441({ buffer, channels, frames: Math.min(need, CHUNK_FRAMES) });

					if (got === undefined || got[0].length === 0) {
						inputExhausted = true;
						break;
					}

					const left = got[0];
					const right = got[1];
					const frames = left.length;

					for (let index = 0; index < frames; index++) {
						segLeft[segFilled + index] = ((left[index] ?? 0) - stats.mean) * inv;
						segRight[segFilled + index] = ((right[index] ?? 0) - stats.mean) * inv;
					}

					segFilled += frames;
				}
			}

			if (segFilled === 0) break;

			const chunkLength = segFilled;
			const paddedLeft = reflectPad(segLeft, pad, padEnd, paddedLen);
			const paddedRight = reflectPad(segRight, pad, padEnd, paddedLen);
			const stftInputLeft = reflectPad(paddedLeft, stftPadConst, stftPadConst, stftLenConst);
			const stftInputRight = reflectPad(paddedRight, stftPadConst, stftPadConst, stftLenConst);
			const stftLeft = computeStftScaled(stftInputLeft);
			const stftRight = computeStftScaled(stftInputRight);

			const { inputData, xData } = buildModelInput(segLeft, segRight, stftLeft, stftRight, SEGMENT_SAMPLES, xBinsConst, xFramesConst);

			const result = this.session.run({
				input: { data: inputData, dims: [1, 2, SEGMENT_SAMPLES] },
				x: { data: xData, dims: [1, 4, xBinsConst, xFramesConst] },
			});

			const xtOut = result.add_67 ?? result[Object.keys(result).pop() ?? ""];
			const xOut = result.output ?? result[Object.keys(result)[0] ?? ""];

			extractStems(xtOut, xOut, workspace, stemAccum, weight, 0, chunkLength, SEGMENT_SAMPLES);
			for (let index = 0; index < chunkLength; index++) {
				sumWeight[index] = (sumWeight[index] ?? 0) + (weight[index] ?? 0);
			}

			const isFinalIter = inputExhausted;
			const nStable = isFinalIter ? chunkLength : stride;

			await this.emitStable({
				nStable,
				stemAccum,
				sumWeight,
				stats,
				stemGains,
				output,
				channels,
				bitDepth,
				originalFrames,
				writerState,
			});

			stableEmitted += nStable;

			const doneFrames = Math.min(stableEmitted, originalFrames);

			if (progressGate(doneFrames, Date.now())) this.emitProgress("process", doneFrames, originalFrames);

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

		await padTail(output, channels, originalFrames, writerState.written, HTDEMUCS_SAMPLE_RATE, bitDepth);
	}

	private async emitStable(args: {
		readonly nStable: number;
		readonly stemAccum: ReadonlyArray<Float32Array>;
		readonly sumWeight: Float32Array;
		readonly stats: { readonly mean: number; readonly std: number };
		readonly stemGains: ReadonlyArray<number>;
		readonly output: BlockBuffer;
		readonly channels: number;
		readonly bitDepth: number | undefined;
		readonly originalFrames: number;
		readonly writerState: { written: number };
	}): Promise<void> {
		const { nStable, stemAccum, sumWeight, stats, stemGains, output, channels, bitDepth, originalFrames, writerState } = args;

		if (nStable <= 0) return;

		const { outLeft, outRight } = mixStemsToStereo(stemAccum, sumWeight, stemGains, stats, nStable);

		// Bandpass at 44.1 kHz native rate, per the original behaviour.
		bandpass([outLeft, outRight], HTDEMUCS_SAMPLE_RATE, this.properties.highPass, this.properties.lowPass);

		const writeChannels = buildWriteChannels(outLeft, outRight, channels);
		const remaining = Math.max(0, originalFrames - writerState.written);

		if (remaining > 0) {
			const take = Math.min(nStable, remaining);
			const sliced = take === nStable ? writeChannels : writeChannels.map((channel) => channel.subarray(0, take));

			await output.write(sliced, HTDEMUCS_SAMPLE_RATE, bitDepth);
			writerState.written += take;
		}

		for (let stem = 0; stem < STEM_OUTPUTS; stem++) {
			const arr = stemAccum[stem];

			if (!arr) continue;
			arr.copyWithin(0, nStable, SEGMENT_SAMPLES);
			arr.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
		}

		sumWeight.copyWithin(0, nStable, SEGMENT_SAMPLES);
		sumWeight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
	}
}

// === Helpers ===

async function computeStreamingStats(buffer: BlockBuffer, channels: number): Promise<{ readonly mean: number; readonly std: number }> {
	await buffer.reset();

	let sum = 0;
	let count = 0;

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const frames = chunk.samples[0]?.length ?? 0;

		if (frames === 0) break;

		// Reference normalizes over both channels jointly; mono treats channel 0 as both L and R.
		const left = chunk.samples[0];
		const right = channels >= 2 ? chunk.samples[1] : chunk.samples[0];

		if (left) {
			for (let index = 0; index < frames; index++) sum += left[index] ?? 0;
			count += frames;
		}

		if (right) {
			for (let index = 0; index < frames; index++) sum += right[index] ?? 0;
			count += frames;
		}

		if (frames < CHUNK_FRAMES) break;
	}

	const mean = count > 0 ? sum / count : 0;

	await buffer.reset();

	let variance = 0;
	let varCount = 0;

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const frames = chunk.samples[0]?.length ?? 0;

		if (frames === 0) break;

		const left = chunk.samples[0];
		const right = channels >= 2 ? chunk.samples[1] : chunk.samples[0];

		if (left) {
			for (let index = 0; index < frames; index++) {
				const diff = (left[index] ?? 0) - mean;

				variance += diff * diff;
			}

			varCount += frames;
		}

		if (right) {
			for (let index = 0; index < frames; index++) {
				const diff = (right[index] ?? 0) - mean;

				variance += diff * diff;
			}

			varCount += frames;
		}

		if (frames < CHUNK_FRAMES) break;
	}

	const std = varCount > 0 ? Math.sqrt(variance / varCount) || 1 : 1;

	return { mean, std };
}

async function pullNextChunkAt441(args: {
	readonly buffer: BlockBuffer;
	readonly channels: number;
	readonly frames: number;
}): Promise<readonly [Float32Array, Float32Array] | undefined> {
	const { buffer, channels, frames } = args;

	const chunk = await buffer.read(frames);
	const got = chunk.samples[0]?.length ?? 0;

	if (got === 0) return undefined;

	const left = chunk.samples[0] ?? new Float32Array(got);
	const right = channels >= 2 ? (chunk.samples[1] ?? left) : left;

	return [left, right];
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

async function padTail(output: BlockBuffer, channels: number, originalFrames: number, written: number, sampleRate: number, bitDepth: number | undefined): Promise<void> {
	if (written >= originalFrames) return;

	const missing = originalFrames - written;
	const padChannels: Array<Float32Array> = [];

	for (let channel = 0; channel < Math.max(1, channels); channel++) {
		padChannels.push(new Float32Array(missing));
	}

	await output.write(padChannels, sampleRate, bitDepth);
}

export class HtdemucsNode extends TransformNode<HtdemucsProperties> {
	static override readonly nodeName = "HTDemucs (Stem Separator)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Rebalance stem volumes using HTDemucs source separation";
	static override readonly schema = schema;
	static override readonly Stream = HtdemucsStream;
}

export function htdemucs(
	modelPath: string,
	stems: Partial<StemGains>,
	options?: {
		ffmpegPath?: string;
		onnxAddonPath?: string;
		id?: string;
	},
): HtdemucsNode {
	return new HtdemucsNode({
		modelPath,
		ffmpegPath: options?.ffmpegPath,
		onnxAddonPath: options?.onnxAddonPath,
		stems: {
			vocals: stems.vocals ?? 1,
			drums: stems.drums ?? 1,
			bass: stems.bass ?? 1,
			other: stems.other ?? 1,
		},
		id: options?.id,
	});
}
