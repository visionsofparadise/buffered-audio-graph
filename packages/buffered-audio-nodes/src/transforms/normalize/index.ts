import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BlockBuffer, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	ceiling: z.number().min(0).max(1).multipleOf(0.01).default(1.0).describe("Ceiling"),
});

export interface NormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class NormalizeStream extends BufferedTransformStream<NormalizeProperties> {
	override blockSize = WHOLE_FILE;

	private peak = 0;

	override prepare(block: Block): Block {
		for (let ch = 0; ch < block.samples.length; ch++) {
			const channel = block.samples[ch] ?? new Float32Array(0);

			for (let si = 0; si < channel.length; si++) {
				const absolute = Math.abs(channel[si] ?? 0);

				if (Number.isFinite(absolute) && absolute > this.peak) this.peak = absolute;
			}
		}

		return block;
	}

	override async transform(buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
		const raw = this.peak === 0 ? 1 : this.properties.ceiling / this.peak;
		const scale = Number.isFinite(raw) ? raw : 1;

		for await (const block of buffered.iterate(44100)) {
			if (scale === 1) {
				enqueue(block);

				continue;
			}

			const scaledSamples = block.samples.map((channel) => {
				const scaled = new Float32Array(channel.length);

				for (let index = 0; index < channel.length; index++) {
					scaled[index] = (channel[index] ?? 0) * scale;
				}

				return scaled;
			});

			enqueue({ samples: scaledSamples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth });
		}
	}
}

export class NormalizeNode extends TransformNode<NormalizeProperties> {
	static override readonly nodeName = "Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Adjust peak or loudness level to a target ceiling";
	static override readonly schema = schema;
	static override readonly streamClass = NormalizeStream;
	static override is(value: unknown): value is NormalizeNode {
		return TransformNode.is(value) && value.type[2] === "normalize";
	}

	override readonly type = ["buffered-audio-node", "transform", "normalize"] as const;

	override clone(overrides?: Partial<NormalizeProperties>): NormalizeNode {
		return new NormalizeNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function normalize(options?: { ceiling?: number; id?: string }): NormalizeNode {
	return new NormalizeNode(options ?? {});
}
