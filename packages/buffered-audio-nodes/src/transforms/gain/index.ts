import { z } from "zod";
import { BufferedTransformStream, TransformNode, type AudioChunk, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	gain: z.number().min(-60).max(24).multipleOf(0.1).default(0).describe("Gain (dB)"),
});

export interface GainProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class GainStream extends BufferedTransformStream<GainProperties> {
	override _unbuffer(chunk: AudioChunk): AudioChunk {
		const linear = Math.pow(10, this.properties.gain / 20);

		if (linear === 1) return chunk;

		const samples = chunk.samples.map((channel) => {
			const output = new Float32Array(channel.length);

			for (let index = 0; index < channel.length; index++) {
				output[index] = (channel[index] ?? 0) * linear;
			}

			return output;
		});

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class GainNode extends TransformNode<GainProperties> {
	static override readonly moduleName = "Gain";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Adjust signal level by a fixed amount in dB";
	static override readonly schema = schema;
	static override is(value: unknown): value is GainNode {
		return TransformNode.is(value) && value.type[2] === "gain";
	}

	override readonly type = ["buffered-audio-node", "transform", "gain"] as const;

	override createStream(): GainStream {
		return new GainStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<GainProperties>): GainNode {
		return new GainNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function gain(options?: { gain?: number; id?: string }): GainNode {
	const parsed = schema.parse(options ?? {});

	return new GainNode({ ...parsed, id: options?.id });
}
