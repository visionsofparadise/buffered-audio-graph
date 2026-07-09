import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { readWavSamples } from "../../utils/read-to-buffer";

export const schema = z.object({
	insertPath: z.string().default("").meta({ input: "file", mode: "open", accept: ".wav" }).describe("Insert File Path"),
	insertAt: z.number().min(0).default(0).describe("Insert At (frames)"),
});

export interface SpliceProperties extends z.infer<typeof schema>, TransformNodeProperties {
	readonly channels?: ReadonlyArray<number>;
}

export class SpliceStream extends UnbufferedTransformStream<SpliceNode> {
	private insertSamples!: Array<Float32Array>;
	private insertSampleRate = 0;
	private insertLength = 0;
	private sampleRateChecked = false;

	override async _setup(_context: StreamContext): Promise<void> {
		const { samples, sampleRate } = await readWavSamples(this.properties.insertPath);

		const targetChannels = this.properties.channels;

		if (targetChannels) {
			for (const ch of targetChannels) {
				if (ch < 0) {
					throw new Error(`Splice: target channel ${ch} is out of range`);
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
		const chunkStart = chunk.offset;
		const chunkEnd = chunkStart + chunkFrames;
		const insertEnd = this.properties.insertAt + this.insertLength;

		if (chunkEnd <= this.properties.insertAt || chunkStart >= insertEnd) {
			yield chunk;

			return;
		}

		const samples = chunk.samples.map((channel) => new Float32Array(channel));

		const overlapStart = Math.max(0, this.properties.insertAt - chunkStart);
		const overlapEnd = Math.min(chunkFrames, insertEnd - chunkStart);
		const insertOffset = Math.max(0, chunkStart - this.properties.insertAt);

		const targetChannels = this.properties.channels;

		if (targetChannels) {
			for (let insertCh = 0; insertCh < targetChannels.length; insertCh++) {
				const primaryCh = targetChannels[insertCh];

				if (primaryCh === undefined) continue;
				const channelSamples = samples[primaryCh];
				const insertChannel = this.insertSamples[insertCh];

				if (!channelSamples || !insertChannel) continue;

				for (let frame = overlapStart; frame < overlapEnd; frame++) {
					const insertIndex = insertOffset + frame - overlapStart;
					const insertSample = insertChannel[insertIndex];

					if (insertSample !== undefined) {
						channelSamples[frame] = insertSample;
					}
				}
			}
		} else {
			for (let ch = 0; ch < samples.length; ch++) {
				const channelSamples = samples[ch];
				const insertChannel = this.insertSamples[ch];

				if (!channelSamples || !insertChannel) continue;

				for (let frame = overlapStart; frame < overlapEnd; frame++) {
					const insertIndex = insertOffset + frame - overlapStart;
					const insertSample = insertChannel[insertIndex];

					if (insertSample !== undefined) {
						channelSamples[frame] = insertSample;
					}
				}
			}
		}

		yield { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class SpliceNode extends TransformNode<SpliceProperties> {
	static override readonly nodeName = "Splice";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Replace a region of audio with processed content";
	static override readonly schema = schema;
	static override readonly Stream = SpliceStream;
}

export function splice(insertPath: string, insertAt: number, options?: { channels?: ReadonlyArray<number> }): SpliceNode {
	return new SpliceNode({ insertPath, insertAt, channels: options?.channels });
}
