import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block } from "@buffered-audio/core";
import { PACKAGE_NAME } from "../../package-metadata";
import { downmixToMono } from "./utils/mix";

export const schema = z.object({});

export class DownmixMonoStream extends UnbufferedTransformStream {
	override *_transform(chunk: Block): Generator<Block> {
		const channels = chunk.samples.length;

		if (channels === 0 || channels === 1) {
			yield chunk;

			return;
		}

		yield { samples: [downmixToMono(chunk.samples)], offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class DownmixMonoNode extends TransformNode {
	static override readonly nodeName = "Downmix Mono";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Mix all input channels to a single mono channel by averaging";
	static override readonly schema = schema;
	static override readonly Stream = DownmixMonoStream;
}

export function downmixMono(options?: { id?: string }): DownmixMonoNode {
	return new DownmixMonoNode({ id: options?.id });
}
