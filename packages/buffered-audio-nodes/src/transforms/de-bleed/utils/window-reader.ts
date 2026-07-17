/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loops with bounds-checked typed array access */
import type { BlockBuffer } from "@buffered-audio/core";

export class WindowReader {
	private readonly scratch: Array<Float32Array>;
	private readonly windowSamples: number;
	private readonly channels: number;
	private virtualCursor = 0;
	private bufferDrained = false;

	constructor(channels: number, windowSamples: number) {
		this.channels = channels;
		this.windowSamples = windowSamples;
		this.scratch = [];
		for (let channelIndex = 0; channelIndex < channels; channelIndex++) this.scratch.push(new Float32Array(windowSamples));
	}

	getScratch(): Array<Float32Array> {
		return this.scratch;
	}

	async preload(buffer: BlockBuffer, edgePadSamples: number): Promise<void> {
		for (let channelIndex = 0; channelIndex < this.channels; channelIndex++) this.scratch[channelIndex]!.fill(0);

		this.virtualCursor = 0;
		this.bufferDrained = false;

		const headPad = Math.min(edgePadSamples, this.windowSamples);
		const remainingInWindow = this.windowSamples - headPad;

		if (remainingInWindow > 0) await this.readInto(buffer, headPad, remainingInWindow);

		this.virtualCursor = this.windowSamples;
	}

	async advance(buffer: BlockBuffer, step: number): Promise<void> {
		if (step <= 0) return;

		const keep = this.windowSamples - step;

		for (let channelIndex = 0; channelIndex < this.channels; channelIndex++) {
			const view = this.scratch[channelIndex]!;

			if (keep > 0) view.copyWithin(0, step, this.windowSamples);
			view.fill(0, keep, this.windowSamples);
		}

		await this.readInto(buffer, keep, step);
		this.virtualCursor += step;
	}

	private async readInto(buffer: BlockBuffer, writeOffset: number, length: number): Promise<void> {
		if (this.bufferDrained) return;

		let remaining = length;
		let outOffset = writeOffset;

		while (remaining > 0) {
			const chunk = await buffer.read(remaining);
			const chunkFrames = chunk.samples[0]?.length ?? 0;

			if (chunkFrames === 0) {
				this.bufferDrained = true;

				return;
			}

			for (let channelIndex = 0; channelIndex < this.channels; channelIndex++) {
				const sourceSamples = chunk.samples[channelIndex];
				const dest = this.scratch[channelIndex]!;

				if (sourceSamples) dest.set(sourceSamples.subarray(0, chunkFrames), outOffset);
			}

			outOffset += chunkFrames;
			remaining -= chunkFrames;
		}
	}
}
