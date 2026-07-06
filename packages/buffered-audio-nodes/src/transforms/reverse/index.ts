import { z } from "zod";
import { BufferedTransformStream, type BlockBuffer, reverseBuffer, TransformNode, WHOLE_FILE, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

const CHUNK_FRAMES = 44100;

export const schema = z.object({});

export class ReverseStream extends BufferedTransformStream {
	override async _process(buffer: BlockBuffer): Promise<void> {
		const channels = buffer.channels;

		if (channels === 0 || buffer.frames === 0) return;

		const sr = buffer.sampleRate ?? 44100;
		const bd = buffer.bitDepth;
		const output = await reverseBuffer(buffer);

		try {
			await buffer.clear();
			await output.reset();

			for (;;) {
				const chunk = await output.read(CHUNK_FRAMES);
				const chunkFrames = chunk.samples[0]?.length ?? 0;

				if (chunkFrames === 0) break;
				await buffer.write(chunk.samples, sr, bd);
				if (chunkFrames < CHUNK_FRAMES) break;
			}
		} finally {
			await output.close();
		}
	}
}

export class ReverseNode extends TransformNode {
	static override readonly nodeName = "Reverse";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Reverse audio playback direction";
	static override readonly schema = schema;
	static override is(value: unknown): value is ReverseNode {
		return TransformNode.is(value) && value.type[2] === "reverse";
	}

	override readonly type = ["buffered-audio-node", "transform", "reverse"] as const;

	constructor(properties?: TransformNodeProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): ReverseStream {
		return new ReverseStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<TransformNodeProperties>): ReverseNode {
		return new ReverseNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function reverse(options?: { id?: string }): ReverseNode {
	return new ReverseNode({ id: options?.id });
}
