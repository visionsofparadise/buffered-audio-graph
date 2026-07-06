import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	bitDepth: z
		.union([z.literal(16), z.literal(24)])
		.default(16)
		.describe("Bit Depth"),
	noiseShaping: z.boolean().default(false).describe("Noise Shaping"),
});

export interface DitherProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class DitherStream extends UnbufferedTransformStream<DitherProperties> {
	private lastError: Array<number> = [];

	override transform(chunk: Block, enqueue: (block: Block) => void): void {
		const { bitDepth, noiseShaping } = this.properties;
		const quantizationLevels = Math.pow(2, bitDepth - 1);
		const lsb = 1 / quantizationLevels;

		while (this.lastError.length < chunk.samples.length) {
			this.lastError.push(0);
		}

		const samples = chunk.samples.map((channel, ch) => {
			const output = new Float32Array(channel.length);

			for (let index = 0; index < channel.length; index++) {
				const sample = channel[index] ?? 0;
				const tpdfNoise = (Math.random() - Math.random()) * lsb;

				let dithered = sample + tpdfNoise;

				if (noiseShaping) {
					dithered += this.lastError[ch] ?? 0;
				}

				const quantized = Math.round(dithered * quantizationLevels) / quantizationLevels;

				if (noiseShaping) {
					this.lastError[ch] = dithered - quantized;
				}

				output[index] = quantized;
			}

			return output;
		});

		enqueue({ samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: this.properties.bitDepth });
	}
}

export class DitherNode extends TransformNode<DitherProperties> {
	static override readonly nodeName = "Dither";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Add shaped noise to reduce quantization distortion";
	static override readonly schema = schema;
	static override readonly streamClass = DitherStream;
	static override is(value: unknown): value is DitherNode {
		return TransformNode.is(value) && value.type[2] === "dither";
	}

	override readonly type = ["buffered-audio-node", "transform", "dither"] as const;

	override clone(overrides?: Partial<DitherProperties>): DitherNode {
		return new DitherNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function dither(
	bitDepth: 16 | 24,
	options?: {
		noiseShaping?: boolean;
		id?: string;
	},
): DitherNode {
	return new DitherNode({ bitDepth, noiseShaping: options?.noiseShaping, id: options?.id });
}
