import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BlockBuffer, type TransformNodeProperties } from "@buffered-audio/core";
import { TruePeakAccumulator } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	target: z.number().lt(0).default(-1).describe("Target true peak (dBTP). Must be < 0."),
});

export interface TruePeakNormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class TruePeakNormalizeStream extends BufferedTransformStream<TruePeakNormalizeProperties> {
	override blockSize = WHOLE_FILE;

	private accumulator?: TruePeakAccumulator;

	override prepare(block: Block): Block {
		const frames = block.samples[0]?.length ?? 0;
		const channelCount = block.samples.length;

		if (frames === 0 || channelCount === 0) return block;

		this.accumulator ??= new TruePeakAccumulator(block.sampleRate, channelCount);
		this.accumulator.push(block.samples, frames);

		return block;
	}

	override async transform(buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
		const gain = this.resolveGain();

		for await (const block of buffered.iterate(44100)) {
			if (gain === 1) {
				enqueue(block);

				continue;
			}

			const samples = block.samples.map((channel) => {
				const output = new Float32Array(channel.length);

				for (let index = 0; index < channel.length; index++) {
					output[index] = (channel[index] ?? 0) * gain;
				}

				return output;
			});

			enqueue({ samples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth });
		}
	}

	private resolveGain(): number {
		if (this.accumulator === undefined) return 1;

		const sourcePeakLinear = this.accumulator.finalize();

		if (sourcePeakLinear <= 0) {
			this.log("true peak measured", { sourceTpDb: -Infinity, targetDb: this.properties.target, gain: 1 });

			return 1;
		}

		const sourcePeakDb = 20 * Math.log10(sourcePeakLinear);
		const gain = Math.pow(10, (this.properties.target - sourcePeakDb) / 20);

		this.log("true peak measured", { sourceTpDb: sourcePeakDb, targetDb: this.properties.target, gain });

		return gain;
	}
}

export class TruePeakNormalizeNode extends TransformNode<TruePeakNormalizeProperties> {
	static override readonly nodeName = "True Peak Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Measure source true peak (4× upsampled, BS.1770-4 style) and apply a single linear gain to hit a target dBTP";
	static override readonly schema = schema;
	static override readonly streamClass = TruePeakNormalizeStream;
	static override is(value: unknown): value is TruePeakNormalizeNode {
		return TransformNode.is(value) && value.type[2] === "true-peak-normalize";
	}

	override readonly type = ["buffered-audio-node", "transform", "true-peak-normalize"] as const;

	override clone(overrides?: Partial<TruePeakNormalizeProperties>): TruePeakNormalizeNode {
		return new TruePeakNormalizeNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function truePeakNormalize(options?: { target?: number; id?: string }): TruePeakNormalizeNode {
	return new TruePeakNormalizeNode(options ?? {});
}
