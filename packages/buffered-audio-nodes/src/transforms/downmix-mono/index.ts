import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({});

export class DownmixMonoStream extends UnbufferedTransformStream {
	override *_transform(chunk: Block): Generator<Block> {
		const channels = chunk.samples.length;

		if (channels === 0 || channels === 1) {
			yield chunk;

			return;
		}

		const frames = chunk.samples[0]?.length ?? 0;
		const mono = new Float32Array(frames);
		const scale = 1 / channels;

		for (let ch = 0; ch < channels; ch++) {
			const channel = chunk.samples[ch] ?? new Float32Array(0);

			for (let index = 0; index < frames; index++) {
				mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) * scale;
			}
		}

		yield { samples: [mono], offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class DownmixMonoNode extends TransformNode {
	static override readonly nodeName = "Downmix Mono";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Mix all input channels to a single mono channel by averaging";
	static override readonly schema = schema;
	static override readonly Stream = DownmixMonoStream;
}

export function downmixMono(options?: { id?: string }): DownmixMonoNode {
	return new DownmixMonoNode({ id: options?.id });
}
