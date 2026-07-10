import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { balanceScales, panGains } from "./utils/pan-law";

export const schema = z.object({
	pan: z.number().min(-1).max(1).multipleOf(0.01).default(0).describe("Pan (-1 = full left, 0 = center, 1 = full right)"),
});

export interface PanProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class PanStream extends UnbufferedTransformStream<PanNode> {
	override *_transform(chunk: Block): Generator<Block> {
		const { pan } = this.properties;
		const channels = chunk.samples.length;

		if (channels > 2) {
			throw new Error(`PanNode supports 1 or 2 channel inputs only, got ${channels}`);
		}

		const { leftGain, rightGain } = panGains(pan);

		if (channels === 1) {
			const mono = chunk.samples[0] ?? new Float32Array(0);
			const frames = mono.length;
			const left = new Float32Array(frames);
			const right = new Float32Array(frames);

			for (let index = 0; index < frames; index++) {
				const sample = mono[index] ?? 0;

				left[index] = sample * leftGain;
				right[index] = sample * rightGain;
			}

			yield { samples: [left, right], offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };

			return;
		}

		const inputLeft = chunk.samples[0] ?? new Float32Array(0);
		const inputRight = chunk.samples[1] ?? new Float32Array(0);
		const frames = inputLeft.length;
		const outputLeft = new Float32Array(frames);
		const outputRight = new Float32Array(frames);

		const { leftScale, rightScale } = balanceScales(pan);

		for (let index = 0; index < frames; index++) {
			outputLeft[index] = (inputLeft[index] ?? 0) * leftScale;
			outputRight[index] = (inputRight[index] ?? 0) * rightScale;
		}

		yield { samples: [outputLeft, outputRight], offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class PanNode extends TransformNode<PanProperties> {
	static override readonly nodeName = "Pan";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Position mono signal in stereo field or adjust stereo balance; throws for inputs with more than 2 channels";
	static override readonly schema = schema;
	static override readonly Stream = PanStream;
}

export function pan(options?: { pan?: number; id?: string }): PanNode {
	return new PanNode(options ?? {});
}
