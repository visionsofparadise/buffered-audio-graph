import { z } from "zod";
import { BufferedTransformStream, ChunkBuffer, TransformNode, WHOLE_FILE, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { findFirstAbove, findLastAbove } from "./utils/silence";

const CHUNK_FRAMES = 44100;

export const schema = z.object({
	threshold: z.number().min(0).max(1).multipleOf(0.001).default(0.001).describe("Threshold"),
	margin: z.number().min(0).max(1).multipleOf(0.001).default(0.01).describe("Margin"),
	start: z.boolean().default(true).describe("Start"),
	end: z.boolean().default(true).describe("End"),
});

export interface TrimProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class TrimStream extends BufferedTransformStream<TrimProperties> {
	override async _process(buffer: ChunkBuffer): Promise<void> {
		const frames = buffer.frames;
		const channels = buffer.channels;

		if (channels === 0 || frames === 0) return;

		const threshold = this.properties.threshold;
		const sr = buffer.sampleRate ?? 44100;
		const bd = buffer.bitDepth;
		const marginFrames = Math.round(this.properties.margin * sr);
		const trimStart = this.properties.start;
		const trimEnd = this.properties.end;

		// Pass 1 — scan forward, tracking first/last absolute frame indices above threshold.
		await buffer.reset();
		let firstAbove = frames;
		let lastAbove = -1;
		let scanOffset = 0;

		for (;;) {
			const chunk = await buffer.read(CHUNK_FRAMES);
			const chunkFrames = chunk.samples[0]?.length ?? 0;

			if (chunkFrames === 0) break;

			const localFirst = findFirstAbove(chunk.samples, chunkFrames, threshold);

			if (localFirst < chunkFrames) {
				const abs = scanOffset + localFirst;

				if (abs < firstAbove) firstAbove = abs;
				lastAbove = Math.max(lastAbove, scanOffset + findLastAbove(chunk.samples, chunkFrames, threshold));
			}

			scanOffset += chunkFrames;
			if (chunkFrames < CHUNK_FRAMES) break;
		}

		if (firstAbove >= frames) {
			// Nothing above threshold — drop everything.
			await buffer.clear();

			return;
		}

		let startFrame = 0;
		let endFrame = frames;

		if (trimStart) {
			startFrame = Math.max(0, firstAbove - marginFrames);
		}

		if (trimEnd) {
			endFrame = Math.min(frames, lastAbove + 1 + marginFrames);
		}

		if (startFrame >= endFrame) {
			await buffer.clear();

			return;
		}

		if (startFrame === 0 && endFrame === frames) return;

		// Pass 2 — copy the keep region into a output buffer, then swap.
		const output = new ChunkBuffer();

		try {
			await buffer.reset();
			let copyOffset = 0;

			for (;;) {
				const chunk = await buffer.read(CHUNK_FRAMES);
				const chunkFrames = chunk.samples[0]?.length ?? 0;

				if (chunkFrames === 0) break;

				const chunkStart = copyOffset;
				const chunkEnd = copyOffset + chunkFrames;
				const overlapStart = Math.max(chunkStart, startFrame);
				const overlapEnd = Math.min(chunkEnd, endFrame);

				if (overlapEnd > overlapStart) {
					const sliceStart = overlapStart - chunkStart;
					const sliceEnd = overlapEnd - chunkStart;

					if (sliceStart === 0 && sliceEnd === chunkFrames) {
						await output.write(chunk.samples, sr, bd);
					} else {
						const sliced: Array<Float32Array> = [];

						for (let ch = 0; ch < channels; ch++) {
							const source = chunk.samples[ch];

							if (source) sliced.push(source.subarray(sliceStart, sliceEnd));
							else sliced.push(new Float32Array(sliceEnd - sliceStart));
						}

						await output.write(sliced, sr, bd);
					}
				}

				copyOffset = chunkEnd;
				if (copyOffset >= endFrame) break;
				if (chunkFrames < CHUNK_FRAMES) break;
			}

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

export class TrimNode extends TransformNode<TrimProperties> {
	static override readonly moduleName = "Trim";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Remove silence from start and end";
	static override readonly schema = schema;
	static override is(value: unknown): value is TrimNode {
		return TransformNode.is(value) && value.type[2] === "trim";
	}

	override readonly type = ["buffered-audio-node", "transform", "trim"] as const;

	constructor(properties: TrimProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): TrimStream {
		return new TrimStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<TrimProperties>): TrimNode {
		return new TrimNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function trim(options?: { threshold?: number; margin?: number; start?: boolean; end?: boolean; id?: string }): TrimNode {
	const parsed = schema.parse(options ?? {});

	return new TrimNode({ ...parsed, id: options?.id });
}
