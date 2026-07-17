import { BufferedTransformStream, TransformNode, type Block, type BlockBuffer, type StreamContext, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createOnnxSession, type OnnxSession } from "../../utils/onnx-runtime";
import { createResampleComposition } from "../../utils/resample-composition";
import type { FfmpegStream } from "../ffmpeg";
import { createDfnState, DFN3_HOP_SIZE, DFN3_SAMPLE_RATE, processDfnBlock, type DfnState } from "./utils/dfn";

const DFN3_BUFFER_SIZE = 100 * DFN3_HOP_SIZE; // = 48000 frames = 1 s blocks at 48 kHz

export const schema = z.object({
	modelPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", accept: ".onnx", binary: "dfn3", download: "https://github.com/yuyun2000/SpeechDenoiser" })
		.describe("DeepFilterNet3 48 kHz denoiser model (.onnx)"),
	ffmpegPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" })
		.describe("FFmpeg — used when the input audio is not 48 kHz to chain up/down resamplers around the inference stream; can be left blank for 48 kHz input."),
	onnxAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "onnx-addon", download: "https://github.com/visionsofparadise/onnx-runtime-addon" })
		.describe("ONNX Runtime native addon"),
	attenuation: z.number().min(0).max(100).default(30).describe("Attenuation cap in dB. Maps to the ONNX `atten_lim_db` input; 0 = no cap"),
});

export interface DeepFilterNet3Properties extends z.infer<typeof schema>, TransformNodeProperties {}

export class DeepFilterNet3Stream extends BufferedTransformStream<DeepFilterNet3Node> {
	override blockSize = DFN3_BUFFER_SIZE;

	private session?: OnnxSession;
	private dfnStates: Array<DfnState> = [];
	private readonly renderContext: StreamContext;
	private upResample?: FfmpegStream;
	private downResample?: FfmpegStream;

	constructor(node: DeepFilterNet3Node, context: StreamContext) {
		super(node, context);

		this.renderContext = context;
	}

	override _setup(context: StreamSetupContext): void {
		// CPU-only: DML rejects DFN3 ops; see design-onnx-providers.
		this.session = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath, { executionProviders: ["cpu"] }, (message, data) => this.log(message, data));

		const composition = createResampleComposition({ context, streamContext: this.renderContext, ffmpegPath: this.properties.ffmpegPath, modelRate: DFN3_SAMPLE_RATE });

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
		if (!this.session) throw new Error("deep-filter-net-3: stream not set up");

		const session = this.session;
		const frames = buffered.frames;
		const channels = buffered.channels;

		if (frames === 0 || channels === 0) return;

		// Single-call read(frames) is safe only because blockSize bounds the block, not because processDfnBlock streams.
		await buffered.reset();
		const chunk = await buffered.read(frames);

		while (this.dfnStates.length < channels) {
			this.dfnStates.push(createDfnState());
		}

		const outputChannels: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) {
			const channel = chunk.samples[ch];
			const dfnState = this.dfnStates[ch];

			if (!channel || !dfnState) {
				outputChannels.push(new Float32Array(frames));

				continue;
			}

			const denoised = processDfnBlock(dfnState, channel, session, this.properties.attenuation);

			outputChannels.push(denoised);
		}

		yield { samples: outputChannels, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}

	override _destroy(): void {
		this.session?.dispose();
		this.session = undefined;
		this.dfnStates = [];
	}
}

export class DeepFilterNet3Node extends TransformNode<DeepFilterNet3Properties> {
	static override readonly nodeName = "DeepFilterNet3 (Denoiser)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description =
		"Remove background noise from speech using DeepFilterNet3 (48 kHz full-band CRN). At other source rates, the internal resampling round trip may add or drop up to two source-rate frames.";
	static override readonly schema = schema;
	static override readonly Stream = DeepFilterNet3Stream;
}

export function deepFilterNet3(options: { modelPath: string; ffmpegPath?: string; onnxAddonPath?: string; attenuation?: number; id?: string }): DeepFilterNet3Node {
	return new DeepFilterNet3Node(options);
}
