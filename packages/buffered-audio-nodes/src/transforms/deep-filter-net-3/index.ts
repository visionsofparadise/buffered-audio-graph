import {
	TransformNode,
	type Block,
	type BlockBuffer,
	type StreamSetupContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createFfmpegPathField, createOnnxAddonPathField } from "../../utils/binary-fields";
import { OnnxTransformStream } from "../../utils/onnx-stream";
import { createDfnState, DFN3_HOP_SIZE, DFN3_SAMPLE_RATE, processDfnBlock, type DfnState } from "./utils/dfn";
import type { OnnxSession } from "../../utils/onnx-runtime";

const DFN3_BUFFER_SIZE = 100 * DFN3_HOP_SIZE;

const schema = z.object({
	modelPath: z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			accept: ".onnx",
			binary: "dfn3",
			download: "https://github.com/yuyun2000/SpeechDenoiser",
		})
		.describe("DeepFilterNet3 48 kHz denoiser model (.onnx)"),
	ffmpegPath: createFfmpegPathField(
		"FFmpeg — used when the input audio is not 48 kHz to chain up/down resamplers around the inference stream; can be left blank for 48 kHz input.",
	),
	onnxAddonPath: createOnnxAddonPathField(),
	attenuation: z
		.number()
		.min(0)
		.max(100)
		.default(30)
		.describe("Attenuation cap in dB. Maps to the ONNX `atten_lim_db` input; 0 = no cap"),
});

export interface DeepFilterNet3Properties extends z.infer<typeof schema>, TransformNodeProperties {}

export class DeepFilterNet3Stream extends OnnxTransformStream<DeepFilterNet3Node> {
	override blockSize = DFN3_BUFFER_SIZE;

	private session?: OnnxSession;
	private dfnStates: Array<DfnState> = [];

	override _setup(context: StreamSetupContext): void {
		this.session = this.setupModelSession(context, {
			modelPath: this.properties.modelPath,
			modelRate: DFN3_SAMPLE_RATE,
			executionProviders: ["cpu"],
		});
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		if (!this.session) throw new Error("deep-filter-net-3: stream not set up");

		const session = this.session;
		const frames = buffered.frames;
		const channels = buffered.channels;

		if (frames === 0 || channels === 0) return;

		await buffered.reset();

		const chunk = await buffered.read(frames);

		while (this.dfnStates.length < channels) {
			this.dfnStates.push(createDfnState());
		}

		const outputChannels: Array<Float32Array> = [];

		for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
			const channel = chunk.samples[channelIndex];
			const dfnState = this.dfnStates[channelIndex];

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

export function deepFilterNet3(options: {
	modelPath: string;
	ffmpegPath?: string;
	onnxAddonPath?: string;
	attenuation?: number;
	id?: string;
}): DeepFilterNet3Node {
	return new DeepFilterNet3Node(options);
}
