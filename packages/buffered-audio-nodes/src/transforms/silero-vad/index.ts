import {
	createProgressGate,
	TransformNode,
	WHOLE_FILE,
	type Block,
	type BlockBuffer,
	type StreamContext,
	type StreamSetupContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { dbToLinear } from "@buffered-audio/utils";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createFfmpegPathField, createOnnxAddonPathField } from "../../utils/binary-fields";
import { OnnxTransformStream } from "../../utils/onnx-stream";
import { createAnalysisStream, readAnalysisStream } from "./utils/analysis-stream";
import { GateGain } from "./utils/gate-gain";
import { mapSegmentsToRate, padSegments, probabilitiesToSegments } from "./utils/segments";
import { runVadWindows } from "./utils/vad";
import type { OnnxSession } from "../../utils/onnx-runtime";

const schema = z.object({
	modelPath: z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			accept: ".onnx",
			binary: "silero-vad",
			download: "https://github.com/snakers4/silero-vad",
		})
		.describe("Silero VAD model, 16 kHz sr-frozen (.onnx)"),
	ffmpegPath: createFfmpegPathField(),
	onnxAddonPath: createOnnxAddonPathField(),
	threshold: z.number().min(0).max(1).default(0.5).describe("Speech probability above which the gate opens"),
	minSpeechDuration: z.number().min(0).default(0.25).describe("Shortest speech region kept, in seconds"),
	minSilenceDuration: z.number().min(0).default(0.1).describe("Silence required before the gate closes, in seconds"),
	speechPad: z.number().min(0).default(0.03).describe("Padding kept around each speech region, in seconds"),
	attack: z.number().min(0).default(0.02).describe("Fade-in before each speech region, in seconds"),
	release: z.number().min(0).default(0.05).describe("Fade-out after each speech region, in seconds"),
	attenuation: z.number().min(-120).max(0).default(-40).describe("Gain applied outside speech regions, in dB"),
});

export interface SileroVadProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class SileroVadStream extends OnnxTransformStream<SileroVadNode> {
	override blockSize = WHOLE_FILE;

	private readonly streamContext: StreamContext;
	private setupContext?: StreamSetupContext;
	private session?: OnnxSession;

	constructor(node: SileroVadNode, context: StreamContext) {
		super(node, context);

		this.streamContext = context;
	}

	override _setup(context: StreamSetupContext): void {
		this.setupContext = context;
		this.session = this.createSession(this.properties.modelPath, { executionProviders: ["cpu"] });
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		if (!this.session) throw new Error("silero-vad: stream not set up");

		if (!this.setupContext) throw new Error("silero-vad: stream not set up");

		const session = this.session;
		const setupContext = this.setupContext;
		const originalFrames = buffered.frames;
		const channels = buffered.channels;

		if (originalFrames === 0 || channels === 0) return;

		const VAD_SAMPLE_RATE = 16000;
		const WINDOW_FRAMES = 512;
		const CHUNK_FRAMES = 44100;
		const originalRate = setupContext.sampleRate;
		const {
			threshold,
			minSpeechDuration,
			minSilenceDuration,
			speechPad,
			attack,
			release,
			attenuation,
			ffmpegPath,
		} = this.properties;

		await buffered.reset();

		const analysisGate = createProgressGate(originalFrames);
		const analysisStream = createAnalysisStream({
			blocks: buffered.iterate(CHUNK_FRAMES),
			ffmpegPath,
			streamContext: this.streamContext,
			setupContext,
		});

		let analysisFrames = 0;
		const probabilities = await runVadWindows(session, readAnalysisStream(analysisStream), (framesDone) => {
			analysisFrames = framesDone;

			const mapped = Math.min(Math.round((framesDone * originalRate) / VAD_SAMPLE_RATE), originalFrames);

			if (analysisGate(mapped, Date.now())) this.emitProgress("process", mapped, originalFrames);
		});

		const minSpeechFrames = Math.round(minSpeechDuration * VAD_SAMPLE_RATE);
		const minSilenceFrames = Math.round(minSilenceDuration * VAD_SAMPLE_RATE);
		const padFrames = Math.round(speechPad * VAD_SAMPLE_RATE);
		const rawSegments = probabilitiesToSegments(probabilities, {
			threshold,
			minSpeechFrames,
			minSilenceFrames,
			windowFrames: WINDOW_FRAMES,
			totalFrames: analysisFrames,
		});
		const paddedSegments = padSegments(rawSegments, padFrames, analysisFrames);
		const sourceSegments = mapSegmentsToRate(paddedSegments, VAD_SAMPLE_RATE, originalRate, originalFrames);

		let speechFrames = 0;

		for (const segment of sourceSegments) {
			speechFrames += segment.end - segment.start;
		}

		this.log("speech detected", {
			segmentCount: sourceSegments.length,
			speechSeconds: speechFrames / originalRate,
			totalSeconds: originalFrames / originalRate,
		});

		await buffered.reset();

		const gateGain = new GateGain(sourceSegments, {
			attackFrames: Math.round(attack * originalRate),
			releaseFrames: Math.round(release * originalRate),
			floorGain: dbToLinear(attenuation),
		});
		const applyGate = createProgressGate(originalFrames);
		let appliedFrames = 0;

		for await (const block of buffered.iterate(CHUNK_FRAMES)) {
			const frames = block.samples[0]?.length ?? 0;

			if (frames === 0) {
				yield block;

				continue;
			}

			const gain = new Float32Array(frames);

			gateGain.fill(gain, appliedFrames);

			const samples = block.samples.map((channel) => {
				const outputChannel = new Float32Array(frames);

				for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
					outputChannel[frameIndex] = (channel[frameIndex] ?? 0) * (gain[frameIndex] ?? 0);
				}

				return outputChannel;
			});

			yield { samples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth };

			appliedFrames += frames;

			const doneFrames = Math.min(appliedFrames, originalFrames);

			if (applyGate(doneFrames, Date.now())) this.emitProgress("process", doneFrames, originalFrames);
		}
	}

	override _destroy(): void {
		this.session?.dispose();
		this.session = undefined;
	}
}

export class SileroVadNode extends TransformNode<SileroVadProperties> {
	static override readonly nodeName = "Silero VAD (Voice Gate)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Attenuate non-speech regions using Silero VAD speech detection";
	static override readonly schema = schema;
	static override readonly Stream = SileroVadStream;
}

export function sileroVad(options: {
	modelPath: string;
	ffmpegPath?: string;
	onnxAddonPath?: string;
	threshold?: number;
	minSpeechDuration?: number;
	minSilenceDuration?: number;
	speechPad?: number;
	attack?: number;
	release?: number;
	attenuation?: number;
	id?: string;
}): SileroVadNode {
	return new SileroVadNode(options);
}
