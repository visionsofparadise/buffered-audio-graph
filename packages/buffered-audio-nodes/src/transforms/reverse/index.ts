import { z } from "zod";
import { BufferedTransformStream, type Block, type BlockBuffer, TransformNode, WHOLE_FILE, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

const CHUNK_FRAMES = 44100;

export const schema = z.object({});

export class ReverseStream extends BufferedTransformStream {
	override blockSize = WHOLE_FILE;

	override async transform(buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
		if (buffered.channels === 0 || buffered.frames === 0) return;

		const reader = await buffered.openReverseReader();

		try {
			for await (const block of reader.iterate(CHUNK_FRAMES)) {
				enqueue(block);
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
	static override readonly nodeDescription = "Reverse audio playback direction";
	static override readonly schema = schema;
	static override readonly streamClass = ReverseStream;
	static override is(value: unknown): value is ReverseNode {
		return TransformNode.is(value) && value.type[2] === "reverse";
	}

	override readonly type = ["buffered-audio-node", "transform", "reverse"] as const;

	override clone(overrides?: Partial<TransformNodeProperties>): ReverseNode {
		return new ReverseNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function reverse(options?: { id?: string }): ReverseNode {
	return new ReverseNode(options ?? {});
}
