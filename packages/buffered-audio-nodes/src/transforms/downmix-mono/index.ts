import { z } from "zod";
import { BufferedTransformStream, TransformNode, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({});

export class DownmixMonoStream extends BufferedTransformStream {
	override _unbuffer(chunk: Block): Block {
		const channels = chunk.samples.length;

		if (channels === 0) return chunk;
		if (channels === 1) return chunk;

		const frames = chunk.samples[0]?.length ?? 0;
		const mono = new Float32Array(frames);
		const scale = 1 / channels;

		for (let ch = 0; ch < channels; ch++) {
			const channel = chunk.samples[ch] ?? new Float32Array(0);

			for (let index = 0; index < frames; index++) {
				mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) * scale;
			}
		}

		return { samples: [mono], offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class DownmixMonoNode extends TransformNode {
	static override readonly nodeName = "Downmix Mono";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Mix all input channels to a single mono channel by averaging";
	static override readonly schema = schema;
	static override is(value: unknown): value is DownmixMonoNode {
		return TransformNode.is(value) && value.type[2] === "downmix-mono";
	}

	override readonly type = ["buffered-audio-node", "transform", "downmix-mono"] as const;

	override createStream(): DownmixMonoStream {
		return new DownmixMonoStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<TransformNodeProperties>): DownmixMonoNode {
		return new DownmixMonoNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function downmixMono(options?: { id?: string }): DownmixMonoNode {
	return new DownmixMonoNode({ id: options?.id });
}
