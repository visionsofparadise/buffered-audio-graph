import { createProgressGate } from "@buffered-audio/core";
import { pullModelChunk, type BoundedWriter } from "./model-blocks";
import type { BlockBuffer } from "@buffered-audio/core";

export class SegmentPump {
	readonly left: Float32Array;
	readonly right: Float32Array;

	private filled = 0;
	private exhausted = false;

	private readonly segmentSamples: number;
	private readonly stride: number;

	constructor(segmentSamples: number, overlap: number) {
		this.segmentSamples = segmentSamples;
		this.stride = Math.round((1 - overlap) * segmentSamples);
		this.left = new Float32Array(segmentSamples);
		this.right = new Float32Array(segmentSamples);
	}

	async run(args: {
		readonly buffer: BlockBuffer;
		readonly writer: BoundedWriter;
		readonly channels: number;
		readonly chunkFrames: number;
		readonly originalFrames: number;
		readonly onFilled?: (start: number, end: number) => void;
		readonly onSegment: (chunkLength: number, stableSamples: number) => Promise<void>;
		readonly onProgress: (done: number, total: number) => void;
	}): Promise<void> {
		const { buffer, writer, channels, chunkFrames, originalFrames, onFilled, onSegment, onProgress } = args;
		const progressGate = createProgressGate(originalFrames);

		let stableEmitted = 0;

		for (;;) {
			if (!this.exhausted) {
				const appended = await this.fill(buffer, channels, chunkFrames);

				onFilled?.(this.filled - appended, this.filled);
			}

			if (this.filled === 0) break;

			const chunkLength = this.filled;
			const isFinalSegment = this.exhausted;
			const stableSamples = isFinalSegment ? chunkLength : this.stride;

			await onSegment(chunkLength, stableSamples);

			stableEmitted += stableSamples;

			const doneFrames = Math.min(stableEmitted, originalFrames);

			if (progressGate(doneFrames, Date.now())) onProgress(doneFrames, originalFrames);

			if (isFinalSegment) break;

			this.shift(stableSamples);
		}

		await writer.padTail(channels);
	}

	private async fill(buffer: BlockBuffer, channels: number, chunkFrames: number): Promise<number> {
		const startFilled = this.filled;

		while (this.filled < this.segmentSamples) {
			const need = this.segmentSamples - this.filled;
			const got = await pullModelChunk({ buffer, channels, frames: Math.min(need, chunkFrames) });
			const left = got?.[0];
			const right = got?.[1] ?? left;

			if (!left || !right || left.length === 0) {
				this.exhausted = true;

				break;
			}

			const frames = left.length;

			for (let index = 0; index < frames; index++) {
				this.left[this.filled + index] = left[index] ?? 0;
				this.right[this.filled + index] = right[index] ?? 0;
			}

			this.filled += frames;
		}

		return this.filled - startFilled;
	}

	private shift(stableSamples: number): void {
		this.left.copyWithin(0, stableSamples, this.segmentSamples);
		this.right.copyWithin(0, stableSamples, this.segmentSamples);
		this.left.fill(0, this.segmentSamples - stableSamples, this.segmentSamples);
		this.right.fill(0, this.segmentSamples - stableSamples, this.segmentSamples);
		this.filled = this.segmentSamples - stableSamples;
	}
}
