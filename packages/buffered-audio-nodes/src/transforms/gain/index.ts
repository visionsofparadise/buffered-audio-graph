import {
	UnbufferedTransformStream,
	TransformNode,
	type Block,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { applyGain } from "../../utils/gain";

const schema = z.object({
	gain: z.number().min(-60).max(24).multipleOf(0.1).default(0).describe("Gain (dB)"),
});

export interface GainProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class GainStream extends UnbufferedTransformStream<GainNode> {
	override *_transform(block: Block): Generator<Block> {
		const linear = Math.pow(10, this.properties.gain / 20);

		if (linear === 1) {
			yield block;

			return;
		}

		yield applyGain(block, linear);
	}
}

export class GainNode extends TransformNode<GainProperties> {
	static override readonly nodeName = "Gain";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Adjust signal level by a fixed amount in dB";
	static override readonly schema = schema;
	static override readonly Stream = GainStream;
}

export function gain(options?: { gain?: number; id?: string }): GainNode {
	return new GainNode(options ?? {});
}
