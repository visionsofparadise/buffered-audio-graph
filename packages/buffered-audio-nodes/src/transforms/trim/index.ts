import { z } from "zod";
import { BufferedTransformStream, type ChunkBuffer, TransformNode, WHOLE_FILE, type AudioChunk, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { findFirstAbove, findLastAbove } from "./utils/silence";

export const schema = z.object({
	threshold: z.number().min(0).max(1).multipleOf(0.001).default(0.001).describe("Threshold"),
	margin: z.number().min(0).max(1).multipleOf(0.001).default(0.01).describe("Margin"),
	start: z.boolean().default(true).describe("Start"),
	end: z.boolean().default(true).describe("End"),
});

export interface TrimProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class TrimStream extends BufferedTransformStream<TrimProperties> {
	private firstAbove = Infinity;
	private lastAbove = -1;
	private scanOffset = 0;
	private startFrame = 0;
	private endFrame = 0;

	override async _buffer(chunk: AudioChunk, buffer: ChunkBuffer): Promise<void> {
		await super._buffer(chunk, buffer);

		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) return;

		const threshold = this.properties.threshold;
		const localFirst = findFirstAbove(chunk.samples, chunkFrames, threshold);

		if (localFirst < chunkFrames) {
			const abs = this.scanOffset + localFirst;

			if (abs < this.firstAbove) this.firstAbove = abs;
			this.lastAbove = Math.max(this.lastAbove, this.scanOffset + findLastAbove(chunk.samples, chunkFrames, threshold));
		}

		this.scanOffset += chunkFrames;
	}

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const frames = buffer.frames;
		const channels = buffer.channels;

		if (channels === 0 || frames === 0) return;

		if (this.firstAbove >= frames) {
			await buffer.clear();

			return;
		}

		const sr = buffer.sampleRate ?? 44100;
		const marginFrames = Math.round(this.properties.margin * sr);

		let startFrame = 0;
		let endFrame = frames;

		if (this.properties.start) startFrame = Math.max(0, this.firstAbove - marginFrames);
		if (this.properties.end) endFrame = Math.min(frames, this.lastAbove + 1 + marginFrames);

		if (startFrame >= endFrame) {
			await buffer.clear();

			return;
		}

		this.startFrame = startFrame;
		this.endFrame = endFrame;
	}

	override _unbuffer(chunk: AudioChunk): AudioChunk | undefined {
		const frames = chunk.samples[0]?.length ?? 0;
		const chunkStart = chunk.offset;
		const chunkEnd = chunkStart + frames;
		const overlapStart = Math.max(chunkStart, this.startFrame);
		const overlapEnd = Math.min(chunkEnd, this.endFrame);

		if (overlapEnd <= overlapStart) return undefined;

		if (overlapStart === chunkStart && overlapEnd === chunkEnd) {
			return { samples: chunk.samples, offset: chunkStart - this.startFrame, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
		}

		const sliceStart = overlapStart - chunkStart;
		const sliceEnd = overlapEnd - chunkStart;

		return {
			samples: chunk.samples.map((channel) => channel.subarray(sliceStart, sliceEnd)),
			offset: overlapStart - this.startFrame,
			sampleRate: chunk.sampleRate,
			bitDepth: chunk.bitDepth,
		};
	}
}

export class TrimNode extends TransformNode<TrimProperties> {
	static override readonly nodeName = "Trim";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Remove silence from start and end";
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
