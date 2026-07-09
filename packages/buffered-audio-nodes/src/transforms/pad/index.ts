import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { CHUNK_FRAMES } from "./utils/chunk-frames";

export const schema = z.object({
	before: z.number().min(0).multipleOf(0.001).default(0).describe("Before"),
	after: z.number().min(0).multipleOf(0.001).default(0).describe("After"),
});

export interface PadProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class PadStream extends UnbufferedTransformStream<PadNode> {
	private seenChunk = false;
	private capturedSampleRate = 44100;
	private capturedBitDepth = 32;
	private capturedChannels = 0;
	private outputOffset = 0;

	override *_transform(chunk: Block): Generator<Block> {
		const frames = chunk.samples[0]?.length ?? 0;

		if (!this.seenChunk) {
			this.seenChunk = true;
			this.capturedSampleRate = chunk.sampleRate;
			this.capturedBitDepth = chunk.bitDepth;
			this.capturedChannels = chunk.samples.length;

			const leading = Math.round(this.properties.before * chunk.sampleRate);

			if (leading > 0) {
				const samples = chunk.samples.map((channel) => {
					const padded = new Float32Array(leading + frames);

					padded.set(channel, leading);

					return padded;
				});
				const offset = this.outputOffset;

				this.outputOffset += leading + frames;

				yield { samples, offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };

				return;
			}
		}

		const offset = this.outputOffset;

		this.outputOffset += frames;

		yield { samples: chunk.samples, offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}

	override *_flush(): Generator<Block> {
		if (!this.seenChunk) return;

		const trailing = Math.round(this.properties.after * this.capturedSampleRate);

		if (trailing === 0) return;

		let remaining = trailing;

		while (remaining > 0) {
			const take = Math.min(CHUNK_FRAMES, remaining);
			const samples = Array.from({ length: this.capturedChannels }, () => new Float32Array(take));
			const offset = this.outputOffset;

			this.outputOffset += take;
			yield { samples, offset, sampleRate: this.capturedSampleRate, bitDepth: this.capturedBitDepth };
			remaining -= take;
		}
	}
}

export class PadNode extends TransformNode<PadProperties> {
	static override readonly nodeName = "Pad";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Add silence to start or end of audio";
	static override readonly schema = schema;
	static override readonly Stream = PadStream;
}

export function pad(options: { before?: number; after?: number; id?: string }): PadNode {
	return new PadNode(options);
}
