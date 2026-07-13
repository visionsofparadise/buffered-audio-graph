import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BlockBuffer, type TransformNodeProperties } from "@buffered-audio/core";
import { TruePeakAccumulator } from "@buffered-audio/utils";
import { PACKAGE_NAME } from "../../package-metadata";
import { resolveTruePeakGain } from "./utils/gain";

export const schema = z.object({
	target: z.number().min(-24).lt(0).default(-1).describe("Target true peak (dBTP). Must be < 0."),
});

export interface TruePeakNormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class TruePeakNormalizeStream extends BufferedTransformStream<TruePeakNormalizeNode> {
	override blockSize = WHOLE_FILE;

	private accumulator?: TruePeakAccumulator;

	override _prepare(block: Block): Block {
		const frames = block.samples[0]?.length ?? 0;
		const channelCount = block.samples.length;

		if (frames === 0 || channelCount === 0) return block;

		this.accumulator ??= new TruePeakAccumulator(block.sampleRate, channelCount);
		this.accumulator.push(block.samples, frames);

		return block;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const gain = this.resolveGain();

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

	private resolveGain(): number {
		if (this.accumulator === undefined) return 1;

		const { gain, sourceTpDb } = resolveTruePeakGain(this.accumulator.finalize(), this.properties.target);

		this.log("true peak measured", { sourceTpDb, targetDb: this.properties.target, gain });

		return gain;
	}
}

export class TruePeakNormalizeNode extends TransformNode<TruePeakNormalizeProperties> {
	static override readonly nodeName = "True Peak Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Measure source true peak (4× upsampled, BS.1770-4 style) and apply a single linear gain to hit a target dBTP";
	static override readonly schema = schema;
	static override readonly Stream = TruePeakNormalizeStream;
}

export function truePeakNormalize(options?: { target?: number; id?: string }): TruePeakNormalizeNode {
	return new TruePeakNormalizeNode(options ?? {});
}
