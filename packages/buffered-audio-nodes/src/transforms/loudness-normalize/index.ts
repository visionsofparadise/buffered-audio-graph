import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BlockBuffer, type TransformNodeProperties } from "@buffered-audio/core";
import { IntegratedLufsAccumulator } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	target: z.number().min(-50).max(0).multipleOf(0.1).default(-16).describe("Target integrated loudness (LUFS)"),
});

export interface LoudnessNormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class LoudnessNormalizeStream extends BufferedTransformStream<LoudnessNormalizeProperties> {
	override blockSize = WHOLE_FILE;

	private accumulator?: IntegratedLufsAccumulator;

	override prepare(block: Block): Block {
		const frames = block.samples[0]?.length ?? 0;
		const channelCount = block.samples.length;

		if (frames === 0 || channelCount === 0) return block;

		this.accumulator ??= new IntegratedLufsAccumulator(block.sampleRate, channelCount);
		this.accumulator.push(block.samples, frames);

		return block;
	}

	override async transform(buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
		const integrated = this.accumulator === undefined ? -Infinity : this.accumulator.finalize();
		const gain = Number.isFinite(integrated) ? Math.pow(10, (this.properties.target - integrated) / 20) : 1;

		for await (const block of buffered.iterate(44100)) {
			if (gain === 1) {
				enqueue(block);

				continue;
			}

			const samples = block.samples.map((channel) => {
				const output = new Float32Array(channel.length);

				for (let index = 0; index < channel.length; index++) {
					output[index] = (channel[index] ?? 0) * gain;
				}

				return output;
			});

			enqueue({ samples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth });
		}
	}
}

export class LoudnessNormalizeNode extends TransformNode<LoudnessNormalizeProperties> {
	static override readonly nodeName = "Loudness Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Measure integrated loudness (BS.1770) and apply a single linear gain to hit a target LUFS — no limiting, no dynamics";
	static override readonly schema = schema;
	static override readonly streamClass = LoudnessNormalizeStream;
	static override is(value: unknown): value is LoudnessNormalizeNode {
		return TransformNode.is(value) && value.type[2] === "loudness-normalize";
	}

	override readonly type = ["buffered-audio-node", "transform", "loudness-normalize"] as const;

	override clone(overrides?: Partial<LoudnessNormalizeProperties>): LoudnessNormalizeNode {
		return new LoudnessNormalizeNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function loudnessNormalize(options?: { target?: number; id?: string }): LoudnessNormalizeNode {
	return new LoudnessNormalizeNode(options ?? {});
}
