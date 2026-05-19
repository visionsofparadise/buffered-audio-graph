import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type AudioChunk, type ChunkBuffer, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { measureIntegratedLufs } from "./utils/measurement";

export const schema = z.object({
	target: z.number().min(-50).max(0).multipleOf(0.1).default(-16).describe("Target integrated loudness (LUFS)"),
});

export interface LoudnessNormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class LoudnessNormalizeStream extends BufferedTransformStream<LoudnessNormalizeProperties> {
	private gain = 1;

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const sampleRate = buffer.sampleRate ?? this.sampleRate ?? 44100;
		const integrated = await measureIntegratedLufs(buffer, sampleRate);

		// Silent / sub-block-length signal: no measurable loudness; pass
		// through unchanged. Linear shift to a target is undefined when
		// there's nothing to shift.
		if (!Number.isFinite(integrated)) {
			this.gain = 1;

			return;
		}

		this.gain = Math.pow(10, (this.properties.target - integrated) / 20);
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

export class LoudnessNormalizeNode extends TransformNode<LoudnessNormalizeProperties> {
	static override readonly moduleName = "Loudness Normalize";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Measure integrated loudness (BS.1770) and apply a single linear gain to hit a target LUFS — no limiting, no dynamics";
	static override readonly schema = schema;
	static override is(value: unknown): value is LoudnessNormalizeNode {
		return TransformNode.is(value) && value.type[2] === "loudness-normalize";
	}

	override readonly type = ["buffered-audio-node", "transform", "loudness-normalize"] as const;

	constructor(properties: LoudnessNormalizeProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): LoudnessNormalizeStream {
		return new LoudnessNormalizeStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<LoudnessNormalizeProperties>): LoudnessNormalizeNode {
		return new LoudnessNormalizeNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function loudnessNormalize(options?: { target?: number; id?: string }): LoudnessNormalizeNode {
	const parsed = schema.parse(options ?? {});

	return new LoudnessNormalizeNode({ ...parsed, id: options?.id });
}
