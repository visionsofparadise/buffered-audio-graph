import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME } from "../../package-metadata";
import { readWavSamples } from "../../utils/read-to-buffer";
import { applyInsert, computeInsertOverlap } from "./utils/insert";

export const schema = z.object({
	insertPath: z.string().default("").meta({ input: "file", mode: "open", accept: ".wav" }).describe("Insert File Path"),
	insertAt: z.number().min(0).max(1_000_000_000).default(0).describe("Insert At (frames)"),
});

export interface SpliceProperties extends z.infer<typeof schema>, TransformNodeProperties {
	readonly channels?: ReadonlyArray<number>;
}

export class SpliceStream extends UnbufferedTransformStream<SpliceNode> {
	private insertSamples!: Array<Float32Array>;
	private insertSampleRate = 0;
	private insertLength = 0;
	private sampleRateChecked = false;

	override async _setup(_context: StreamSetupContext): Promise<void> {
		const { samples, sampleRate } = await readWavSamples(this.properties.insertPath);

		const targetChannels = this.properties.channels;

		if (targetChannels) {
			for (const targetChannel of targetChannels) {
				if (targetChannel < 0) {
					throw new Error(`Splice: target channel ${targetChannel} is out of range`);
				}
			}
		}

		this.insertSamples = samples;
		this.insertSampleRate = sampleRate;
		this.insertLength = samples[0]?.length ?? 0;
	}

	override *_transform(chunk: Block): Generator<Block> {
		if (!this.sampleRateChecked) {
			this.sampleRateChecked = true;

			if (this.insertSampleRate !== chunk.sampleRate) {
				throw new Error(`Splice: insert file sample rate ${this.insertSampleRate} does not match stream sample rate ${chunk.sampleRate}`);
			}
		}

		const chunkFrames = chunk.samples[0]?.length ?? 0;
		const overlap = computeInsertOverlap(chunk.offset, chunkFrames, this.properties.insertAt, this.insertLength);

		if (overlap === undefined) {
			yield chunk;

			return;
		}

		const samples = chunk.samples.map((channel) => new Float32Array(channel));

		const targetChannels = this.properties.channels;

		if (targetChannels) {
			for (let insertCh = 0; insertCh < targetChannels.length; insertCh++) {
				const primaryCh = targetChannels[insertCh];

				if (primaryCh === undefined) continue;
				const channelSamples = samples[primaryCh];
				const insertChannel = this.insertSamples[insertCh];

				if (!channelSamples || !insertChannel) continue;

				applyInsert(channelSamples, insertChannel, overlap);
			}
		} else {
			for (let channel = 0; channel < samples.length; channel++) {
				const channelSamples = samples[channel];
				const insertChannel = this.insertSamples[channel];

				if (!channelSamples || !insertChannel) continue;

				applyInsert(channelSamples, insertChannel, overlap);
			}
		}

		yield { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class SpliceNode extends TransformNode<SpliceProperties> {
	static override readonly nodeName = "Splice";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Replace a region of audio with processed content";
	static override readonly schema = schema;
	static override readonly Stream = SpliceStream;
}

export function splice(insertPath: string, insertAt: number, options?: { channels?: ReadonlyArray<number> }): SpliceNode {
	return new SpliceNode({ insertPath, insertAt, channels: options?.channels });
}
