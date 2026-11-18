import { TransformNode, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createLoudnessToolPathField } from "../../utils/binary-fields";
import { CliTransformStream, type CliStreamFormat, type CliStreamInput } from "../cli";
import { buildLoudnessToolArgs, validateLoudnessToolArgs } from "./utils/args";

const schema = z.object({
	loudnessToolPath: createLoudnessToolPathField(),
	args: z
		.array(z.string())
		.superRefine((args, context) => {
			const message = validateLoudnessToolArgs(args);

			if (message !== undefined) context.addIssue({ code: "custom", message });
		})
		.describe(
			'loudness-tool command and options, such as ["target", "--lufs", "-16", "--tp", "-1"]. The command is tp-norm, lufs-norm, target or crest. The node supplies the input, output, stream formats and scratch directory.',
		),
});

export interface LoudnessToolProperties extends TransformNodeProperties {
	readonly loudnessToolPath: string;
	readonly args: Array<string>;
}

export class LoudnessToolStream extends CliTransformStream<LoudnessToolNode> {
	protected override _command(): string {
		return this.properties.loudnessToolPath;
	}

	protected override _label(): string {
		return "loudness-tool";
	}

	protected override _outputFormat(): CliStreamFormat {
		return "wav";
	}

	protected override _buildArgs(context: StreamSetupContext, input: CliStreamInput): Array<string> {
		return buildLoudnessToolArgs(this.properties.args, context.temporaryDirectory, input);
	}
}

export class LoudnessToolNode extends TransformNode<LoudnessToolProperties> {
	static override readonly nodeName: string = "Loudness Tool";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description: string =
		"Process audio through loudness-tool: tp-norm, lufs-norm, target or crest";
	static override readonly schema: z.ZodType = schema;
	static override readonly Stream = LoudnessToolStream;
}

export function loudnessTool(options: {
	loudnessToolPath: string;
	args: Array<string>;
	id?: string;
}): LoudnessToolNode {
	return new LoudnessToolNode({
		loudnessToolPath: options.loudnessToolPath,
		args: options.args,
		id: options.id,
	});
}
