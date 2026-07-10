import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { quantizationLevels, quantizeSample } from "./utils/quantize";

export const schema = z.object({
	bitDepth: z
		.union([z.literal(16), z.literal(24)])
		.default(16)
		.describe("Bit Depth"),
	noiseShaping: z.boolean().default(false).describe("Noise Shaping"),
});

export interface DitherProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class DitherStream extends UnbufferedTransformStream<DitherNode> {
	private lastError: Array<number> = [];

	override *_transform(chunk: Block): Generator<Block> {
		const { bitDepth, noiseShaping } = this.properties;
		const levels = quantizationLevels(bitDepth);
		const lsb = 1 / levels;

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

				const quantized = quantizeSample(dithered, levels);

				if (noiseShaping) {
					this.lastError[ch] = dithered - quantized;
				}

				output[index] = quantized;
			}

			return output;
		});

		yield { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: this.properties.bitDepth };
	}
}

export class DitherNode extends TransformNode<DitherProperties> {
	static override readonly nodeName = "Dither";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Add shaped noise to reduce quantization distortion";
	static override readonly schema = schema;
	static override readonly Stream = DitherStream;
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
