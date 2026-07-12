import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BlockBuffer, type TransformNodeProperties } from "@buffered-audio/core";
import { IntegratedLufsAccumulator } from "@buffered-audio/utils";
import { PACKAGE_NAME } from "../../package-metadata";
import { resolveLoudnessGain } from "./utils/gain";

export const schema = z.object({
	target: z.number().min(-50).max(0).multipleOf(0.1).default(-16).describe("Target integrated loudness (LUFS)"),
});

export interface LoudnessNormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class LoudnessNormalizeStream extends BufferedTransformStream<LoudnessNormalizeNode> {
	override blockSize = WHOLE_FILE;

	private accumulator?: IntegratedLufsAccumulator;

	override _prepare(block: Block): Block {
		const frames = block.samples[0]?.length ?? 0;
		const channelCount = block.samples.length;

		if (frames === 0 || channelCount === 0) return block;

		this.accumulator ??= new IntegratedLufsAccumulator(block.sampleRate, channelCount);
		this.accumulator.push(block.samples, frames);

		return block;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const integrated = this.accumulator === undefined ? -Infinity : this.accumulator.finalize();
		const gain = resolveLoudnessGain(integrated, this.properties.target);

		this.log("loudness measured", { integrated, gain, target: this.properties.target });

		for await (const block of buffered.iterate(44100)) {
			if (gain === 1) {
				yield block;

				continue;
			}

			const samples = block.samples.map((channel) => {
				const output = new Float32Array(channel.length);

				for (let index = 0; index < channel.length; index++) {
					output[index] = (channel[index] ?? 0) * gain;
				}

				return output;
			});

			yield { samples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth };
		}
	}
}

export class LoudnessNormalizeNode extends TransformNode<LoudnessNormalizeProperties> {
	static override readonly nodeName = "Loudness Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Measure integrated loudness (BS.1770) and apply a single linear gain to hit a target LUFS — no limiting, no dynamics";
	static override readonly schema = schema;
	static override readonly Stream = LoudnessNormalizeStream;
}

export function loudnessNormalize(options?: { target?: number; id?: string }): LoudnessNormalizeNode {
	return new LoudnessNormalizeNode(options ?? {});
}
