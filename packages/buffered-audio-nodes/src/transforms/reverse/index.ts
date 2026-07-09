import { z } from "zod";
import { BufferedTransformStream, type Block, type BlockBuffer, TransformNode, WHOLE_FILE } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

const CHUNK_FRAMES = 44100;

export const schema = z.object({});

export class ReverseStream extends BufferedTransformStream {
	override blockSize = WHOLE_FILE;

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		if (buffered.channels === 0 || buffered.frames === 0) return;

		const reader = await buffered.openReverseReader();

		try {
			for await (const block of reader.iterate(CHUNK_FRAMES)) {
				yield block;
			}
		} finally {
			await reader.close();
		}
	}
}

export class ReverseNode extends TransformNode {
	static override readonly nodeName = "Reverse";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Reverse audio playback direction";
	static override readonly schema = schema;
	static override readonly Stream = ReverseStream;
}

export function reverse(options?: { id?: string }): ReverseNode {
	return new ReverseNode(options ?? {});
}
