import { z } from "zod";
import { BufferedTransformStream, TransformNode, type AudioChunk, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

const cutRegionSchema = z.object({
	start: z.number().min(0).describe("Start (seconds)"),
	end: z.number().min(0).describe("End (seconds)"),
});

export const schema = z.object({
	regions: z.array(cutRegionSchema).default([]).describe("Regions"),
});

export type CutRegion = z.infer<typeof cutRegionSchema>;

export interface CutProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class CutStream extends BufferedTransformStream<CutProperties> {
	private sortedRegions: Array<CutRegion>;
	private removedFrames = 0;

	constructor(properties: CutProperties) {
		super(properties);

		this.sortedRegions = [...this.properties.regions].sort((left, right) => left.start - right.start);
	}

	override _unbuffer(chunk: AudioChunk): AudioChunk | undefined {
		const sampleRate = chunk.sampleRate;
		const chunkFrames = chunk.samples[0]?.length ?? 0;
		const chunkStartSec = chunk.offset / sampleRate;
		const keepRanges: Array<{ start: number; end: number }> = [];
		let cursor = 0;

		for (const region of this.sortedRegions) {
			const cutStart = Math.max(0, Math.round((region.start - chunkStartSec) * sampleRate));
			const cutEnd = Math.min(chunkFrames, Math.round((region.end - chunkStartSec) * sampleRate));

			if (cutEnd <= 0 || cutStart >= chunkFrames) continue;

			const clampedStart = Math.max(cursor, 0);
			const clampedEnd = Math.max(clampedStart, cutStart);

			if (clampedEnd > clampedStart) {
				keepRanges.push({ start: clampedStart, end: clampedEnd });
			}

			cursor = Math.max(cursor, cutEnd);
		}

		if (cursor < chunkFrames) {
			keepRanges.push({ start: cursor, end: chunkFrames });
		}

		if (keepRanges.length === 0) return undefined;

		const totalKept = keepRanges.reduce((sum, range) => sum + (range.end - range.start), 0);

		const removedFrames = chunkFrames - totalKept;
		const adjustedOffset = chunk.offset - this.removedFrames;

		this.removedFrames += removedFrames;

		if (totalKept === chunkFrames) {
			return { samples: chunk.samples, offset: adjustedOffset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
		}

		const channels = chunk.samples.length;
		const output: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) {
			const channel = chunk.samples[ch];

			if (!channel) {
				output.push(new Float32Array(totalKept));
				continue;
			}

			const out = new Float32Array(totalKept);
			let writeOffset = 0;

			for (const range of keepRanges) {
				out.set(channel.subarray(range.start, range.end), writeOffset);
				writeOffset += range.end - range.start;
			}

			output.push(out);
		}

		return { samples: output, offset: adjustedOffset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class CutNode extends TransformNode<CutProperties> {
	static override readonly moduleName = "Cut";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Remove a region of audio";
	static override readonly schema = schema;
	static override is(value: unknown): value is CutNode {
		return TransformNode.is(value) && value.type[2] === "cut";
	}

	override readonly type = ["buffered-audio-node", "transform", "cut"] as const;

	override createStream(): CutStream {
		return new CutStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<CutProperties>): CutNode {
		return new CutNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function cut(regions: Array<CutRegion>, options?: { id?: string }): CutNode {
	return new CutNode({ regions, id: options?.id });
}
