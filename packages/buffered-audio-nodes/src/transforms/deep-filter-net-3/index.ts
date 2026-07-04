import { z } from "zod";
import { BufferedTransformStream, TransformNode, type AudioChunk, type ChunkBuffer, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
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
	// One DfnState per channel — DFN3's recurrent state is per-source, so stereo input
	// needs two independent states (matches DTLN's per-channel handling).
	// Allocated lazily on the first `_process` call so we can size to the actual chunk
	// channel count rather than guessing.
	private dfnStates: Array<DfnState> = [];

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<ReadableStream<AudioChunk>> {
		// DML rejects ops in DFN3's graph and silently routes them to CPU per frame, ~5x slower than CPU EP. See plan-dfn-streaming.md.
		this.session = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath, { executionProviders: ["cpu"] }, (message, data) => this.log(message, data));

		const sourceRate = this.properties.sampleRate;

		// Source already at 48 kHz — no resampling composition needed; the inference
		// stream consumes the input directly.
		if (sourceRate === DFN3_SAMPLE_RATE) {
			return super._setup(input, context);
		}

		// Source rate ≠ 48 kHz — chain `upResample` (sourceRate → 48 kHz) before the
		// inference stream and `downResample` (48 kHz → sourceRate) after it. Per the
		// _setup() composition pattern in design-streaming.md §The `_setup()` Hook,
		// inner streams are constructed with properties only, then their `_setup()`
		// is called in order with `context` flowing through unchanged.
		// `outputSampleRate` MUST be set explicitly on each FfmpegStream — without it
		// the wrapper would tag emitted chunks with the input rate (Phase 2 design).
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

	override async _process(buffer: ChunkBuffer): Promise<void> {
		if (!this.session) throw new Error("deep-filter-net-3: stream not set up");

		// Defensive belt-and-braces: the inference stream MUST receive 48 kHz audio.
		// Composition in `_setup` chains up/down resamplers when source rate ≠ 48 kHz,
		// so by the time `_process` runs the upstream chunk rate is always 48 kHz.
		// This guard catches misconfiguration (e.g. caller declared the wrong source
		// rate) before silently producing garbage.
		if (this.sampleRate !== undefined && this.sampleRate !== DFN3_SAMPLE_RATE) {
			throw new Error(`deep-filter-net-3: inference stream received ${this.sampleRate} Hz audio; expected ${DFN3_SAMPLE_RATE} Hz (composition in _setup should have resampled — check sampleRate property and pipeline setup)`);
		}

		const session = this.session;
		const frames = buffer.frames;
		const channels = buffer.channels;
		const sr = buffer.sampleRate;
		const bd = buffer.bitDepth;

		if (frames === 0 || channels === 0) return;

		// dfn3's bufferSize is DFN3_BUFFER_SIZE (~1 s blocks), so the buffer is
		// small enough to pull in one read. The single-call `read(buffer.frames)`
		// here is safe because of that bounded `bufferSize`, not because of any
		// streaming property of `processDfnBlock`.
		await buffer.reset();
		const chunk = await buffer.read(frames);

		// Lazy per-channel state allocation: framework hands us channel count via
		// `buffer.channels`, derived from the first chunk in the chunkBuffer.
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

		// `reset()` only rewinds read cursors — to replace the buffer's contents
		// we drop the existing data and write fresh.
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
	static override readonly moduleName = "DeepFilterNet3 (Denoiser)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Remove background noise from speech using DeepFilterNet3 (48 kHz full-band CRN)";
	static override readonly schema = schema;

	static override is(value: unknown): value is DeepFilterNet3Node {
		return TransformNode.is(value) && value.type[2] === "deep-filter-net-3";
	}

	override readonly type = ["buffered-audio-node", "transform", "deep-filter-net-3"] as const;

	constructor(properties: DeepFilterNet3Properties) {
		// bufferSize: 100 hops = 48 000 frames = 1 s blocks at 48 kHz. Block-aligned to
		// `DFN3_HOP_SIZE` so the framework's slicing always feeds `_process` an exact
		// hop multiple (the trailing partial only happens once via `handleFlush`, and
		// `processDfnBlock` zero-pads/trims internally for that case).
		// latency: STFT-iSTFT inherent latency = `DFN3_FFT_SIZE` (960 samples = 20 ms).
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
