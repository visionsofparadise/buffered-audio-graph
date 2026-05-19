import { z } from "zod";
import { BufferedTransformStream, TransformNode, type AudioChunk, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { readWavSamples } from "../../utils/read-to-buffer";

export const schema = z.object({
	insertPath: z.string().default("").meta({ input: "file", mode: "open", accept: ".wav" }).describe("Insert File Path"),
	insertAt: z.number().min(0).default(0).describe("Insert At (frames)"),
});

export interface SpliceProperties extends z.infer<typeof schema>, TransformNodeProperties {
	readonly channels?: ReadonlyArray<number>;
}

export class SpliceStream extends BufferedTransformStream<SpliceProperties> {
	private insertSamples!: Array<Float32Array>;
	private insertSampleRate = 0;
	private insertLength = 0;
	private sampleRateChecked = false;

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<ReadableStream<AudioChunk>> {
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

		return super._setup(input, context);
	}

	override _unbuffer(chunk: AudioChunk): AudioChunk {
		if (!this.sampleRateChecked) {
			this.sampleRateChecked = true;

			if (this.sampleRate !== undefined && this.insertSampleRate !== this.sampleRate) {
				throw new Error(`Splice: insert file sample rate ${this.insertSampleRate} does not match stream sample rate ${this.sampleRate}`);
			}
		}

		const chunkFrames = chunk.samples[0]?.length ?? 0;
		const chunkStart = chunk.offset;
		const chunkEnd = chunkStart + chunkFrames;
		const insertEnd = this.properties.insertAt + this.insertLength;

		if (chunkEnd <= this.properties.insertAt || chunkStart >= insertEnd) {
			return chunk;
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

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class SpliceNode extends TransformNode<SpliceProperties> {
	static override readonly moduleName = "Splice";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Replace a region of audio with processed content";
	static override readonly schema = schema;
	static override is(value: unknown): value is SpliceNode {
		return TransformNode.is(value) && value.type[2] === "splice";
	}

	override readonly type = ["buffered-audio-node", "transform", "splice"] as const;

	override createStream(): SpliceStream {
		return new SpliceStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<SpliceProperties>): SpliceNode {
		return new SpliceNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function splice(insertPath: string, insertAt: number, options?: { channels?: ReadonlyArray<number> }): SpliceNode {
	return new SpliceNode({ insertPath, insertAt, channels: options?.channels });
}
