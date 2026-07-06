import { z } from "zod";
import { BufferedTransformStream, TransformNode, type Block, type BlockBuffer, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { createOnnxSession, type OnnxSession } from "../../utils/onnx-runtime";
import { FfmpegStream } from "../ffmpeg";
import { createDfnState, DFN3_FFT_SIZE, DFN3_HOP_SIZE, DFN3_SAMPLE_RATE, processDfnBlock, type DfnState } from "./utils/dfn";

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
		.describe("FFmpeg — only used when sampleRate ≠ 48000 to chain up/down resamplers around the inference stream; can be left blank when sampleRate === 48000."),
	onnxAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "onnx-addon", download: "https://github.com/visionsofparadise/onnx-runtime-addon" })
		.describe("ONNX Runtime native addon"),
	sampleRate: z
		.number()
		.int()
		.positive()
		.describe("Source audio sample rate in Hz. Required. When ≠ 48000, ffmpeg resampling is chained around the inference stream via _setup composition."),
	attenuation: z.number().min(0).max(100).default(30).describe("Attenuation cap in dB. Maps to the ONNX `atten_lim_db` input; 0 = no cap"),
});

export interface DeepFilterNet3Properties extends z.infer<typeof schema>, TransformNodeProperties {}

export class DeepFilterNet3Stream extends BufferedTransformStream<DeepFilterNet3Properties> {
	private session?: OnnxSession;
	private dfnStates: Array<DfnState> = [];

	override async _setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		// CPU-only: DML rejects DFN3 ops; see design-onnx-providers.
		this.session = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath, { executionProviders: ["cpu"] }, (message, data) => this.log(message, data));

		const sourceRate = this.properties.sampleRate;

		if (sourceRate === DFN3_SAMPLE_RATE) {
			return super._setup(input, context);
		}

		const upResample = new FfmpegStream({
			ffmpegPath: this.properties.ffmpegPath,
			args: ["-af", `aresample=${DFN3_SAMPLE_RATE}`],
			outputSampleRate: DFN3_SAMPLE_RATE,
			bufferSize: 0,
			overlap: 0,
		});
		const downResample = new FfmpegStream({
			ffmpegPath: this.properties.ffmpegPath,
			args: ["-af", `aresample=${sourceRate}`],
			outputSampleRate: sourceRate,
			bufferSize: 0,
			overlap: 0,
		});

		const upResampled = await upResample._setup(input, context);
		const inferenced = await super._setup(upResampled, context);

		return downResample._setup(inferenced, context);
	}

	override async _process(buffer: BlockBuffer): Promise<void> {
		if (!this.session) throw new Error("deep-filter-net-3: stream not set up");

		// Guard: caller-declared sampleRate mismatch → throw before garbage; see design-transforms DFN3 failure mode.
		if (this.sampleRate !== undefined && this.sampleRate !== DFN3_SAMPLE_RATE) {
			throw new Error(`deep-filter-net-3: inference stream received ${this.sampleRate} Hz audio; expected ${DFN3_SAMPLE_RATE} Hz (composition in _setup should have resampled — check sampleRate property and pipeline setup)`);
		}

		const session = this.session;
		const frames = buffer.frames;
		const channels = buffer.channels;
		const sr = buffer.sampleRate;
		const bd = buffer.bitDepth;

		if (frames === 0 || channels === 0) return;

		// Single-call read(frames) is safe only because bufferSize bounds the block, not because processDfnBlock streams.
		await buffer.reset();
		const chunk = await buffer.read(frames);

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

		// reset() only rewinds read cursors, so clear + rewrite to replace contents.
		await buffer.clear();
		await buffer.write(outputChannels, sr, bd);
	}

	override _teardown(): void {
		this.session?.dispose();
		this.session = undefined;
		this.dfnStates = [];
	}
}

export class DeepFilterNet3Node extends TransformNode<DeepFilterNet3Properties> {
	static override readonly nodeName = "DeepFilterNet3 (Denoiser)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Remove background noise from speech using DeepFilterNet3 (48 kHz full-band CRN)";
	static override readonly schema = schema;

	static override is(value: unknown): value is DeepFilterNet3Node {
		return TransformNode.is(value) && value.type[2] === "deep-filter-net-3";
	}

	override readonly type = ["buffered-audio-node", "transform", "deep-filter-net-3"] as const;

	constructor(properties: DeepFilterNet3Properties) {
		// bufferSize: 100 hops, DFN3_HOP_SIZE-aligned so slicing feeds exact hop multiples. latency: DFN3_FFT_SIZE = 960 = 20 ms STFT-iSTFT latency.
		super({ bufferSize: DFN3_BUFFER_SIZE, latency: DFN3_FFT_SIZE, ...properties });
	}

	override createStream(): DeepFilterNet3Stream {
		return new DeepFilterNet3Stream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<DeepFilterNet3Properties>): DeepFilterNet3Node {
		return new DeepFilterNet3Node({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function deepFilterNet3(options: {
	modelPath: string;
	sampleRate: number;
	ffmpegPath?: string;
	onnxAddonPath?: string;
	attenuation?: number;
	id?: string;
}): DeepFilterNet3Node {
	return new DeepFilterNet3Node({
		modelPath: options.modelPath,
		sampleRate: options.sampleRate,
		ffmpegPath: options.ffmpegPath ?? "",
		onnxAddonPath: options.onnxAddonPath ?? "",
		attenuation: options.attenuation ?? 30,
		id: options.id,
	});
}
