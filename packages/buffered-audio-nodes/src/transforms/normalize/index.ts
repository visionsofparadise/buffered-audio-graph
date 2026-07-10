import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BlockBuffer, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { findPeak, resolveScale } from "./utils/peak";

export const schema = z.object({
	ceiling: z.number().min(0).max(1).multipleOf(0.01).default(1.0).describe("Ceiling"),
});

export interface NormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class NormalizeStream extends BufferedTransformStream<NormalizeNode> {
	override blockSize = WHOLE_FILE;

	private peak = 0;

	override _prepare(block: Block): Block {
		this.peak = Math.max(this.peak, findPeak(block.samples));

		return block;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const scale = resolveScale(this.peak, this.properties.ceiling);

		this.log("peak measured", { peak: this.peak, scale, ceiling: this.properties.ceiling });

		for await (const block of buffered.iterate(44100)) {
			if (scale === 1) {
				yield block;

				continue;
			}

			const scaledSamples = block.samples.map((channel) => {
				const scaled = new Float32Array(channel.length);

				for (let index = 0; index < channel.length; index++) {
					scaled[index] = (channel[index] ?? 0) * scale;
				}

				return scaled;
			});

			yield { samples: scaledSamples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth };
		}
	}
}

export class NormalizeNode extends TransformNode<NormalizeProperties> {
	static override readonly nodeName = "Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Adjust peak or loudness level to a target ceiling";
	static override readonly schema = schema;
	static override readonly Stream = NormalizeStream;
}

export function normalize(options?: { ceiling?: number; id?: string }): NormalizeNode {
	return new NormalizeNode(options ?? {});
}
