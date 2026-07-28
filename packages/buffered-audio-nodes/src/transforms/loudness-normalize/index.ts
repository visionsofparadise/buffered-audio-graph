import {
	BufferedTransformStream,
	TransformNode,
	WHOLE_FILE,
	type Block,
	type BlockBuffer,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { IntegratedLufsAccumulator } from "@buffered-audio/utils";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { accumulateBlock } from "../../utils/accumulate-block";
import { iterateWithGain } from "../../utils/gain";
import { resolveLoudnessGain } from "./utils/gain";

const schema = z.object({
	target: z.number().min(-50).max(0).multipleOf(0.1).default(-16).describe("Target integrated loudness (LUFS)"),
});

export interface LoudnessNormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class LoudnessNormalizeStream extends BufferedTransformStream<LoudnessNormalizeNode> {
	override blockSize = WHOLE_FILE;

	private accumulator?: IntegratedLufsAccumulator;

	override _prepare(block: Block): Block {
		this.accumulator = accumulateBlock(
			this.accumulator,
			block,
			(sampleRate, channelCount) => new IntegratedLufsAccumulator(sampleRate, channelCount),
		);

		return block;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const integrated = this.accumulator === undefined ? -Infinity : this.accumulator.finalize();
		const gain = resolveLoudnessGain(integrated, this.properties.target);

		this.log("loudness measured", { integrated, gain, target: this.properties.target });

		yield* iterateWithGain(buffered, gain, 44100);
	}
}

export class LoudnessNormalizeNode extends TransformNode<LoudnessNormalizeProperties> {
	static override readonly nodeName = "Loudness Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description =
		"Measure integrated loudness (BS.1770) and apply a single linear gain to hit a target LUFS — no limiting, no dynamics";
	static override readonly schema = schema;
	static override readonly Stream = LoudnessNormalizeStream;
}

export function loudnessNormalize(options?: { target?: number; id?: string }): LoudnessNormalizeNode {
	return new LoudnessNormalizeNode(options ?? {});
}
