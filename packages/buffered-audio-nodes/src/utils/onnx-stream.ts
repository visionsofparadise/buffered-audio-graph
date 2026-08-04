import {
	BlockBuffer,
	BufferedTransformStream,
	WHOLE_FILE,
	type Block,
	type BufferedAudioNode,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { createOnnxSession, type OnnxSession, type OnnxSessionOptions } from "./onnx-runtime";
import { createResampleComposition } from "./resample-composition";
import type { FfmpegStream } from "../transforms/ffmpeg";
import type { StreamContext, StreamSetupContext } from "@buffered-audio/core";

export interface OnnxNodeProperties extends TransformNodeProperties {
	readonly ffmpegPath: string;
	readonly onnxAddonPath: string;
}

export interface ModelPassArgs {
	readonly buffer: BlockBuffer;
	readonly output: BlockBuffer;
	readonly channels: number;
	readonly originalFrames: number;
	readonly bitDepth: number | undefined;
}

export abstract class OnnxTransformStream<
	N extends BufferedAudioNode<OnnxNodeProperties> = BufferedAudioNode<OnnxNodeProperties>,
> extends BufferedTransformStream<N> {
	private readonly renderContext: StreamContext;
	private upResample?: FfmpegStream;
	private downResample?: FfmpegStream;

	constructor(node: N, context: StreamContext) {
		super(node, context);

		this.renderContext = context;
	}

	protected createSession(modelPath: string, options: OnnxSessionOptions): OnnxSession {
		return createOnnxSession(this.properties.onnxAddonPath, modelPath, options, (message, data) =>
			this.log(message, data),
		);
	}

	protected setupResampleComposition(context: StreamSetupContext, modelRate: number): void {
		const composition = createResampleComposition({
			context,
			streamContext: this.renderContext,
			ffmpegPath: this.properties.ffmpegPath,
			modelRate,
		});

		if (composition) {
			this.upResample = composition.upResample;
			this.downResample = composition.downResample;
		}
	}

	protected setupModelSession(
		context: StreamSetupContext,
		options: { readonly modelPath: string; readonly modelRate: number } & OnnxSessionOptions,
	): OnnxSession {
		const session = this.createSession(options.modelPath, { executionProviders: options.executionProviders });

		this.setupResampleComposition(context, options.modelRate);

		return session;
	}

	override _pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		if (!this.upResample || !this.downResample) return super._pipe(input);

		return this.downResample._pipe(super._pipe(this.upResample._pipe(input)));
	}
}

export abstract class WholeFileOnnxStream<
	N extends BufferedAudioNode<OnnxNodeProperties> = BufferedAudioNode<OnnxNodeProperties>,
> extends OnnxTransformStream<N> {
	override blockSize = WHOLE_FILE;

	protected abstract readonly modelChunkFrames: number;

	protected abstract runMainPass(args: ModelPassArgs): Promise<void>;

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const originalFrames = buffered.frames;
		const channels = buffered.channels;

		if (originalFrames === 0 || channels === 0) return;

		const bitDepth = this.bitDepth;

		await buffered.reset();

		const output = new BlockBuffer(this.temporaryDirectory);

		try {
			await this.runMainPass({ buffer: buffered, output, channels, originalFrames, bitDepth });

			await output.reset();

			yield* output.iterate(this.modelChunkFrames);
		} finally {
			await output.close();
		}
	}
}
