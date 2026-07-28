import { TransformNode, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { bandpass } from "@buffered-audio/utils";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createFfmpegPathField, createOnnxAddonPathField } from "../../utils/binary-fields";
import { BoundedWriter, buildWriteChannels } from "../../utils/model-blocks";
import { WholeFileOnnxStream, type ModelPassArgs } from "../../utils/onnx-stream";
import { SegmentPump } from "../../utils/segment-pump";
import { buildTriangularWeight, computeStftScaled, reflectPad } from "./utils/dsp";
import { computeStreamingStats } from "./utils/stats";
import { buildModelInput, extractStems, mixStemsToStereo, type StftWorkspace } from "./utils/stems";
import type { OnnxSession } from "../../utils/onnx-runtime";

export interface StemGains {
	readonly vocals: number;
	readonly drums: number;
	readonly bass: number;
	readonly other: number;
}

const schema = z.object({
	modelPath: z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			accept: ".onnx",
			binary: "htdemucs",
			download: "https://github.com/facebookresearch/demucs",
		})
		.describe("HTDemucs source separation model (.onnx) — requires .onnx.data file alongside"),
	ffmpegPath: createFfmpegPathField(),
	onnxAddonPath: createOnnxAddonPathField(),
	highPass: z.number().min(0).max(500).multipleOf(10).default(0).describe("High Pass"),
	lowPass: z.number().min(0).max(22050).multipleOf(100).default(0).describe("Low Pass"),
});

export interface HtdemucsProperties extends z.infer<typeof schema>, TransformNodeProperties {
	readonly stems: StemGains;
}

const HTDEMUCS_SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;
const HOP_SIZE = 1024;
const SEGMENT_SAMPLES = 343980;
const OVERLAP = 0.25;
const TRANSITION_POWER = 1.0;
const CHUNK_FRAMES = 44100;
const STEM_OUTPUTS = 4 * 2;

export class HtdemucsStream extends WholeFileOnnxStream<HtdemucsNode> {
	protected override readonly modelChunkFrames = CHUNK_FRAMES;

	private session!: OnnxSession;

	override _setup(context: StreamSetupContext): void {
		this.session = this.setupModelSession(context, {
			modelPath: this.properties.modelPath,
			modelRate: HTDEMUCS_SAMPLE_RATE,
			executionProviders: ["cpu"],
		});
	}

	protected override async runMainPass(args: ModelPassArgs): Promise<void> {
		const { buffer, output, channels, originalFrames, bitDepth } = args;

		const stats = await computeStreamingStats(buffer, channels, CHUNK_FRAMES);

		this.log("streaming stats computed", { mean: stats.mean, std: stats.std });

		await buffer.reset();

		const writer = new BoundedWriter({
			output,
			sampleRate: HTDEMUCS_SAMPLE_RATE,
			bitDepth,
			totalFrames: originalFrames,
		});

		const weight = buildTriangularWeight(SEGMENT_SAMPLES, TRANSITION_POWER);

		const pad = Math.floor(HOP_SIZE / 2) * 3;
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

		const pump = new SegmentPump(SEGMENT_SAMPLES, OVERLAP);
		const segLeft = pump.left;
		const segRight = pump.right;

		const stemAccum: Array<Float32Array> = [];

		for (let stem = 0; stem < STEM_OUTPUTS; stem++) stemAccum.push(new Float32Array(SEGMENT_SAMPLES));

		const sumWeight = new Float32Array(SEGMENT_SAMPLES);

		const { stems } = this.properties;
		const stemGains = [stems.drums, stems.bass, stems.other, stems.vocals];

		const inv = 1 / (stats.std || 1);

		await pump.run({
			buffer,
			writer,
			channels,
			chunkFrames: CHUNK_FRAMES,
			originalFrames,
			onFilled: (start, end) => {
				for (let index = start; index < end; index++) {
					segLeft[index] = ((segLeft[index] ?? 0) - stats.mean) * inv;
					segRight[index] = ((segRight[index] ?? 0) - stats.mean) * inv;
				}
			},
			onSegment: async (chunkLength, nStable) => {
				const paddedLeft = reflectPad(segLeft, pad, padEnd, paddedLen);
				const paddedRight = reflectPad(segRight, pad, padEnd, paddedLen);
				const stftInputLeft = reflectPad(paddedLeft, stftPadConst, stftPadConst, stftLenConst);
				const stftInputRight = reflectPad(paddedRight, stftPadConst, stftPadConst, stftLenConst);
				const stftLeft = computeStftScaled(stftInputLeft);
				const stftRight = computeStftScaled(stftInputRight);

				const { inputData, xData } = buildModelInput(
					segLeft,
					segRight,
					stftLeft,
					stftRight,
					SEGMENT_SAMPLES,
					xBinsConst,
					xFramesConst,
				);

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

				await this.emitStable({ nStable, stemAccum, sumWeight, stats, stemGains, channels, writer });
			},
			onProgress: (done, total) => this.emitProgress("process", done, total),
		});
	}

	private async emitStable(args: {
		readonly nStable: number;
		readonly stemAccum: ReadonlyArray<Float32Array>;
		readonly sumWeight: Float32Array;
		readonly stats: { readonly mean: number; readonly std: number };
		readonly stemGains: ReadonlyArray<number>;
		readonly channels: number;
		readonly writer: BoundedWriter;
	}): Promise<void> {
		const { nStable, stemAccum, sumWeight, stats, stemGains, channels, writer } = args;

		if (nStable <= 0) return;

		const { outLeft, outRight } = mixStemsToStereo(stemAccum, sumWeight, stemGains, stats, nStable);

		bandpass([outLeft, outRight], HTDEMUCS_SAMPLE_RATE, this.properties.highPass, this.properties.lowPass);

		await writer.write(buildWriteChannels(outLeft, outRight, channels), nStable);

		for (let stem = 0; stem < STEM_OUTPUTS; stem++) {
			const stemAccumulator = stemAccum[stem];

			if (!stemAccumulator) continue;

			stemAccumulator.copyWithin(0, nStable, SEGMENT_SAMPLES);
			stemAccumulator.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
		}

		sumWeight.copyWithin(0, nStable, SEGMENT_SAMPLES);
		sumWeight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
	}
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
