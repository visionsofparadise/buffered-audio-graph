import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type AudioChunk, type ChunkBuffer, type TransformNodeProperties } from "@buffered-audio/core";
import { TruePeakAccumulator } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

// One-second-at-44.1kHz iteration size, matching the convention used by
// `loudness-normalize/utils/measurement.ts`. Balances per-iteration
// overhead against per-chunk allocation pressure.
const CHUNK_FRAMES = 44100;

export const schema = z.object({
	target: z.number().lt(0).default(-1).describe("Target true peak (dBTP). Must be < 0."),
});

export interface TruePeakNormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class TruePeakNormalizeStream extends BufferedTransformStream<TruePeakNormalizeProperties> {
	private gain = 1;

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const sampleRate = buffer.sampleRate ?? this.sampleRate ?? 44100;
		const channelCount = buffer.channels;
		const frames = buffer.frames;

		if (frames === 0 || channelCount === 0) {
			this.gain = 1;

			return;
		}

		const accumulator = new TruePeakAccumulator(sampleRate, channelCount);

		await buffer.reset();

		for (;;) {
			const chunk = await buffer.read(CHUNK_FRAMES);
			const chunkFrames = chunk.samples[0]?.length ?? 0;

			if (chunkFrames === 0) break;

			accumulator.push(chunk.samples, chunkFrames);

			if (chunkFrames < CHUNK_FRAMES) break;
		}

		const sourcePeakLinear = accumulator.finalize();

		// Silent / sub-sample-length signal: linear shift to a target is
		// undefined when there's nothing to shift. Pass through unchanged.
		// Mirrors the silent-source handling in `loudness-normalize`.
		if (sourcePeakLinear <= 0) {
			this.gain = 1;
			console.log(`[true-peak-normalize] sourceTP=-Infinity target=${this.properties.target} gain=1`);

			return;
		}

		const sourcePeakDb = 20 * Math.log10(sourcePeakLinear);

		this.gain = Math.pow(10, (this.properties.target - sourcePeakDb) / 20);

		console.log(`[true-peak-normalize] sourceTP=${sourcePeakDb} target=${this.properties.target} gain=${this.gain}`);
	}

	override _unbuffer(chunk: AudioChunk): AudioChunk {
		const gain = this.gain;

		if (gain === 1) return chunk;

		const samples = chunk.samples.map((channel) => {
			const output = new Float32Array(channel.length);

			for (let index = 0; index < channel.length; index++) {
				output[index] = (channel[index] ?? 0) * gain;
			}

			return output;
		});

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class TruePeakNormalizeNode extends TransformNode<TruePeakNormalizeProperties> {
	static override readonly moduleName = "True Peak Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Measure source true peak (4× upsampled, BS.1770-4 style) and apply a single linear gain to hit a target dBTP";
	static override readonly schema = schema;
	static override is(value: unknown): value is TruePeakNormalizeNode {
		return TransformNode.is(value) && value.type[2] === "true-peak-normalize";
	}

	override readonly type = ["buffered-audio-node", "transform", "true-peak-normalize"] as const;

	constructor(properties: TruePeakNormalizeProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): TruePeakNormalizeStream {
		return new TruePeakNormalizeStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<TruePeakNormalizeProperties>): TruePeakNormalizeNode {
		return new TruePeakNormalizeNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function truePeakNormalize(options?: { target?: number; id?: string }): TruePeakNormalizeNode {
	const parsed = schema.parse(options ?? {});

	return new TruePeakNormalizeNode({ ...parsed, id: options?.id });
}
