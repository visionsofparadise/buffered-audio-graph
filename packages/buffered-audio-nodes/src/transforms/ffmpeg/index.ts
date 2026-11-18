import { TransformNode, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createFfmpegPathField } from "../../utils/binary-fields";
import { CliTransformStream, type CliStreamInput } from "../cli";
import { buildInputArgs, buildOutputArgs } from "./utils/process";

const schema = z.object({
	ffmpegPath: createFfmpegPathField(),
	args: z.array(z.string()).default([]),
	outputSampleRate: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Sample rate of emitted chunks. Required when args change the rate (e.g. -af aresample=24000)."),
});

export interface FfmpegProperties extends TransformNodeProperties {
	readonly ffmpegPath: string;
	readonly args?: Array<string>;
	readonly outputSampleRate?: number;
}

export class FfmpegStream<P extends FfmpegProperties = FfmpegProperties> extends CliTransformStream<FfmpegNode<P>> {
	protected override _command(): string {
		return this.properties.ffmpegPath;
	}

	protected override _label(): string {
		return "ffmpeg";
	}

	protected override _outputSampleRate(): number | undefined {
		return this.properties.outputSampleRate;
	}

	protected override _buildArgs(_context: StreamSetupContext, input: CliStreamInput): Array<string> {
		return [
			...buildInputArgs(input.sampleRate, input.channels),
			...(this.properties.args ?? []),
			...buildOutputArgs(this.properties.outputSampleRate ?? input.sampleRate, input.channels),
		];
	}
}

export class FfmpegNode<P extends FfmpegProperties = FfmpegProperties> extends TransformNode<P> {
	static override readonly nodeName: string = "FFmpeg";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description: string = "Process audio through FFmpeg filters";
	static override readonly schema: z.ZodType = schema;
	static override readonly Stream = FfmpegStream;
}

export function ffmpeg(options: {
	ffmpegPath: string;
	args: Array<string>;
	outputSampleRate?: number;
	id?: string;
}): FfmpegNode {
	return new FfmpegNode({
		ffmpegPath: options.ffmpegPath,
		args: options.args,
		outputSampleRate: options.outputSampleRate,
		id: options.id,
	});
}
