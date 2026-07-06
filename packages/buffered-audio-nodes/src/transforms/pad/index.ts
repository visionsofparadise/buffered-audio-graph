import { z } from "zod";
import { BufferedTransformStream, TransformNode, type AudioChunk, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

const CHUNK_FRAMES = 44100;

export const schema = z.object({
	before: z.number().min(0).multipleOf(0.001).default(0).describe("Before"),
	after: z.number().min(0).multipleOf(0.001).default(0).describe("After"),
});

export interface PadProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class PadStream extends BufferedTransformStream<PadProperties> {
	private seenChunk = false;
	private capturedSampleRate = 44100;
	private capturedBitDepth = 32;
	private capturedChannels = 0;
	private outputOffset = 0;

	override _unbuffer(chunk: AudioChunk): AudioChunk {
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

				return { samples, offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
			}
		}

		const offset = this.outputOffset;

		this.outputOffset += frames;

		return { samples: chunk.samples, offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}

	override _flush(): Array<AudioChunk> | undefined {
		if (!this.seenChunk) return undefined;

		const trailing = Math.round(this.properties.after * this.capturedSampleRate);

		if (trailing === 0) return undefined;

		const chunks: Array<AudioChunk> = [];
		let remaining = trailing;

		while (remaining > 0) {
			const take = Math.min(CHUNK_FRAMES, remaining);
			const samples = Array.from({ length: this.capturedChannels }, () => new Float32Array(take));
			const offset = this.outputOffset;

			this.outputOffset += take;
			chunks.push({ samples, offset, sampleRate: this.capturedSampleRate, bitDepth: this.capturedBitDepth });
			remaining -= take;
		}

		return chunks;
	}
}

export class PadNode extends TransformNode<PadProperties> {
	static override readonly nodeName = "Pad";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Add silence to start or end of audio";
	static override readonly schema = schema;
	static override is(value: unknown): value is PadNode {
		return TransformNode.is(value) && value.type[2] === "pad";
	}

	override readonly type = ["buffered-audio-node", "transform", "pad"] as const;

	constructor(properties: PadProperties) {
		super({ bufferSize: 0, latency: 0, ...properties });
	}

	override createStream(): PadStream {
		return new PadStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<PadProperties>): PadNode {
		return new PadNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function pad(options: { before?: number; after?: number; id?: string }): PadNode {
	const parsed = schema.parse(options);

	return new PadNode({ ...parsed, id: options.id });
}
