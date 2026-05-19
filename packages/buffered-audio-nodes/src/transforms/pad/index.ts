import { z } from "zod";
import { BufferedTransformStream, ChunkBuffer, TransformNode, WHOLE_FILE, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

const CHUNK_FRAMES = 44100;

export const schema = z.object({
	before: z.number().min(0).multipleOf(0.001).default(0).describe("Before"),
	after: z.number().min(0).multipleOf(0.001).default(0).describe("After"),
});

export interface PadProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class PadStream extends BufferedTransformStream<PadProperties> {
	override async _process(buffer: ChunkBuffer): Promise<void> {
		const { before, after } = this.properties;
		const channels = buffer.channels;

		if (channels === 0) return;

		const sr = buffer.sampleRate ?? 44100;
		const bd = buffer.bitDepth;
		const leading = Math.round(before * sr);
		const trailing = Math.round(after * sr);

		if (leading === 0 && trailing === 0) return;

		const output = new ChunkBuffer();

		try {
			await writeSilence(output, leading, channels, CHUNK_FRAMES, sr, bd);

			for (;;) {
				const chunk = await buffer.read(CHUNK_FRAMES);
				const chunkFrames = chunk.samples[0]?.length ?? 0;

				if (chunkFrames === 0) break;
				await output.write(chunk.samples, sr, bd);
				if (chunkFrames < CHUNK_FRAMES) break;
			}

			await writeSilence(output, trailing, channels, CHUNK_FRAMES, sr, bd);

			await buffer.clear();
			await output.reset();

			for (;;) {
				const chunk = await output.read(CHUNK_FRAMES);
				const chunkFrames = chunk.samples[0]?.length ?? 0;

				if (chunkFrames === 0) break;
				await buffer.write(chunk.samples, sr, bd);
				if (chunkFrames < CHUNK_FRAMES) break;
			}
		} finally {
			await output.close();
		}
	}
}

async function writeSilence(target: ChunkBuffer, frames: number, channels: number, chunkSize: number, sampleRate: number, bitDepth: number | undefined): Promise<void> {
	let remaining = frames;

	while (remaining > 0) {
		const take = Math.min(chunkSize, remaining);
		const silence: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) silence.push(new Float32Array(take));
		await target.write(silence, sampleRate, bitDepth);
		remaining -= take;
	}
}

export class PadNode extends TransformNode<PadProperties> {
	static override readonly moduleName = "Pad";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Add silence to start or end of audio";
	static override readonly schema = schema;
	static override is(value: unknown): value is PadNode {
		return TransformNode.is(value) && value.type[2] === "pad";
	}

	override readonly type = ["buffered-audio-node", "transform", "pad"] as const;

	constructor(properties: PadProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): PadStream {
		return new PadStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<PadProperties>): PadNode {
		return new PadNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function pad(options: { before?: number; after?: number; id?: string }): PadNode {
	const parsed = schema.parse(options);

	return new PadNode({ ...parsed, id: options.id });
}
