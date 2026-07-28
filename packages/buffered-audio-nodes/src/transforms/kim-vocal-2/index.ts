import {
	TransformNode,
	type StreamSetupContext,
	type StreamContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { bandpass, MixedRadixFft } from "@buffered-audio/utils";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createFfmpegPathField, createOnnxAddonPathField } from "../../utils/binary-fields";
import { BoundedWriter, buildWriteChannels } from "../../utils/model-blocks";
import { filterOnnxProviders } from "../../utils/onnx-providers";
import { WholeFileOnnxStream, type ModelPassArgs } from "../../utils/onnx-stream";
import { SegmentPump } from "../../utils/segment-pump";
import { buildTransitionWindow, createSegmentWorkspace, processSegment } from "./utils/segment";
import type { OnnxSession } from "../../utils/onnx-runtime";

const schema = z.object({
	modelPath: z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			accept: ".onnx",
			binary: "Kim_Vocal_2",
			download: "https://huggingface.co/seanghay/uvr_models",
		})
		.describe("MDX-Net vocal isolation model (.onnx)"),
	ffmpegPath: createFfmpegPathField(),
	onnxAddonPath: createOnnxAddonPathField(),
	highPass: z.number().min(20).max(500).multipleOf(10).default(80).describe("High Pass"),
	lowPass: z.number().min(1000).max(22050).multipleOf(100).default(20000).describe("Low Pass"),
});

export interface KimVocal2Properties extends z.infer<typeof schema>, TransformNodeProperties {}

const SAMPLE_RATE = 44100;
const N_FFT = 7680;
const HOP_SIZE = 1024;
const DIM_T = 256;
const COMPENSATE = 1.009;
const SEGMENT_SAMPLES = N_FFT + (DIM_T - 1) * HOP_SIZE;
const OVERLAP = 0.25;
const TRANSITION_POWER = 1.0;

const CHUNK_FRAMES = 44100;

export class KimVocal2Stream extends WholeFileOnnxStream<KimVocal2Node> {
	protected override readonly modelChunkFrames = CHUNK_FRAMES;

	private session!: OnnxSession;
	private fftInstance: MixedRadixFft;

	constructor(node: KimVocal2Node, context: StreamContext) {
		super(node, context);
		this.fftInstance = new MixedRadixFft(N_FFT);
	}

	override _setup(context: StreamSetupContext): void {
		this.session = this.setupModelSession(context, {
			modelPath: this.properties.modelPath,
			modelRate: SAMPLE_RATE,
			executionProviders: filterOnnxProviders(context.executionProviders),
		});
	}

	protected override async runMainPass(args: ModelPassArgs): Promise<void> {
		const { buffer, output, channels, originalFrames, bitDepth } = args;
		const isMono = channels < 2;

		const writer = new BoundedWriter({ output, sampleRate: SAMPLE_RATE, bitDepth, totalFrames: originalFrames });

		const weight = buildTransitionWindow(SEGMENT_SAMPLES, TRANSITION_POWER);

		const workspace = createSegmentWorkspace(SEGMENT_SAMPLES);

		const pump = new SegmentPump(SEGMENT_SAMPLES, OVERLAP);
		const segLeft = pump.left;
		const segRight = pump.right;

		const outAccumLeft = new Float32Array(SEGMENT_SAMPLES);
		const outAccumRight = new Float32Array(SEGMENT_SAMPLES);
		const sumWeight = new Float32Array(SEGMENT_SAMPLES);

		await pump.run({
			buffer,
			writer,
			channels,
			chunkFrames: CHUNK_FRAMES,
			originalFrames,
			onSegment: async (chunkLength, nStable) => {
				const processed = processSegment(
					segLeft,
					segRight,
					0,
					chunkLength,
					isMono,
					workspace,
					this.fftInstance,
					this.session,
					COMPENSATE,
				);

				if (processed) {
					for (let index = 0; index < chunkLength; index++) {
						const wt = weight[index] ?? 1;

						outAccumLeft[index] = (outAccumLeft[index] ?? 0) + (processed.left[index] ?? 0) * wt;
						outAccumRight[index] = (outAccumRight[index] ?? 0) + (processed.right[index] ?? 0) * wt;
						sumWeight[index] = (sumWeight[index] ?? 0) + wt;
					}
				}

				await this.emitStable({ nStable, outAccumLeft, outAccumRight, sumWeight, channels, writer });
			},
			onProgress: (done, total) => this.emitProgress("process", done, total),
		});
	}

	private async emitStable(args: {
		readonly nStable: number;
		readonly outAccumLeft: Float32Array;
		readonly outAccumRight: Float32Array;
		readonly sumWeight: Float32Array;
		readonly channels: number;
		readonly writer: BoundedWriter;
	}): Promise<void> {
		const { nStable, outAccumLeft, outAccumRight, sumWeight, channels, writer } = args;

		if (nStable <= 0) return;

		const outLeft = new Float32Array(nStable);
		const outRight = new Float32Array(nStable);

		for (let index = 0; index < nStable; index++) {
			const sw = sumWeight[index] ?? 1;

			outLeft[index] = sw > 0 ? (outAccumLeft[index] ?? 0) / sw : (outAccumLeft[index] ?? 0);
			outRight[index] = sw > 0 ? (outAccumRight[index] ?? 0) / sw : (outAccumRight[index] ?? 0);
		}

		bandpass([outLeft, outRight], SAMPLE_RATE, this.properties.highPass, this.properties.lowPass);

		await writer.write(buildWriteChannels(outLeft, outRight, channels), nStable);

		outAccumLeft.copyWithin(0, nStable, SEGMENT_SAMPLES);
		outAccumLeft.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
		outAccumRight.copyWithin(0, nStable, SEGMENT_SAMPLES);
		outAccumRight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
		sumWeight.copyWithin(0, nStable, SEGMENT_SAMPLES);
		sumWeight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
	}
}

export class KimVocal2Node extends TransformNode<KimVocal2Properties> {
	static override readonly nodeName = "Kim Vocal 2 (Stem Separator)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Isolate dialogue from background using MDX-Net vocal separation";
	static override readonly schema = schema;
	static override readonly Stream = KimVocal2Stream;
}

export function kimVocal2(options: {
	modelPath: string;
	ffmpegPath: string;
	onnxAddonPath?: string;
	highPass?: number;
	lowPass?: number;
	id?: string;
}): KimVocal2Node {
	return new KimVocal2Node(options);
}
