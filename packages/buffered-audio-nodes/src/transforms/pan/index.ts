import { z } from "zod";
import { BufferedTransformStream, TransformNode, type AudioChunk, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	pan: z.number().min(-1).max(1).multipleOf(0.01).default(0).describe("Pan (-1 = full left, 0 = center, 1 = full right)"),
});

export interface PanProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class PanStream extends BufferedTransformStream<PanProperties> {
	override _unbuffer(chunk: AudioChunk): AudioChunk {
		const { pan } = this.properties;
		const channels = chunk.samples.length;

		if (channels > 2) {
			throw new Error(`PanNode supports 1 or 2 channel inputs only, got ${channels}`);
		}

		const theta = ((pan + 1) / 2) * (Math.PI / 2);
		const leftGain = Math.cos(theta);
		const rightGain = Math.sin(theta);

		if (channels === 1) {
			const mono = chunk.samples[0] ?? new Float32Array(0);
			const frames = mono.length;
			const left = new Float32Array(frames);
			const right = new Float32Array(frames);

			for (let index = 0; index < frames; index++) {
				const sample = mono[index] ?? 0;

				left[index] = sample * leftGain;
				right[index] = sample * rightGain;
			}

			return { samples: [left, right], offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
		}

		const inputLeft = chunk.samples[0] ?? new Float32Array(0);
		const inputRight = chunk.samples[1] ?? new Float32Array(0);
		const frames = inputLeft.length;
		const outputLeft = new Float32Array(frames);
		const outputRight = new Float32Array(frames);

		const leftScale = Math.min(1, 1 - pan);
		const rightScale = Math.min(1, 1 + pan);

		for (let index = 0; index < frames; index++) {
			outputLeft[index] = (inputLeft[index] ?? 0) * leftScale;
			outputRight[index] = (inputRight[index] ?? 0) * rightScale;
		}

		return { samples: [outputLeft, outputRight], offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class PanNode extends TransformNode<PanProperties> {
	static override readonly nodeName = "Pan";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Position mono signal in stereo field or adjust stereo balance; throws for inputs with more than 2 channels";
	static override readonly schema = schema;
	static override is(value: unknown): value is PanNode {
		return TransformNode.is(value) && value.type[2] === "pan";
	}

	override readonly type = ["buffered-audio-node", "transform", "pan"] as const;

	override createStream(): PanStream {
		return new PanStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<PanProperties>): PanNode {
		return new PanNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function pan(options?: { pan?: number; id?: string }): PanNode {
	const parsed = schema.parse(options ?? {});

	return new PanNode({ ...parsed, id: options?.id });
}
