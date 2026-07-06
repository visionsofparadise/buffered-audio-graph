/* eslint-disable @typescript-eslint/no-non-null-assertion -- per-channel scratch indexed in lockstep with buffer.channels */
import type { BlockBuffer } from "./block-buffer";

export interface WindowedIterateOptions {
	readonly windowSize: number;
	readonly hopSize: number;
}

export async function windowedIterate(
	buffer: BlockBuffer,
	options: WindowedIterateOptions,
	onWindow: (window: Array<Float32Array>, windowIndex: number) => void | Promise<void>,
): Promise<void> {
	const { windowSize, hopSize } = options;

	if (windowSize <= 0) throw new Error(`windowedIterate: windowSize must be > 0, got ${String(windowSize)}`);
	if (hopSize <= 0) throw new Error(`windowedIterate: hopSize must be > 0, got ${String(hopSize)}`);
	if (hopSize > windowSize) throw new Error(`windowedIterate: hopSize (${String(hopSize)}) must be <= windowSize (${String(windowSize)})`);

	const channels = buffer.channels;

	if (channels === 0) return;

	const scratch: Array<Float32Array> = [];

	for (let ch = 0; ch < channels; ch++) scratch.push(new Float32Array(windowSize));

	const preload = windowSize - hopSize;
	let scratchFilled = 0;

	if (preload > 0) {
		const initial = await buffer.read(preload);
		const initialFrames = initial.samples[0]?.length ?? 0;

		if (initialFrames === 0) return;

		for (let ch = 0; ch < channels; ch++) {
			const src = initial.samples[ch];

			if (src) scratch[ch]!.set(src.subarray(0, initialFrames), 0);
		}

		scratchFilled = initialFrames;

		if (initialFrames < preload) {
			await onWindow(scratch, 0);

			return;
		}
	}

	let windowIndex = 0;

	for (;;) {
		const chunk = await buffer.read(hopSize);
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) {
			if (scratchFilled === windowSize) return;
			if (scratchFilled > preload) {
				for (let ch = 0; ch < channels; ch++) scratch[ch]!.fill(0, scratchFilled, windowSize);
				await onWindow(scratch, windowIndex);
			}

			return;
		}

		if (scratchFilled === windowSize) {
			for (let ch = 0; ch < channels; ch++) {
				const view = scratch[ch]!;

				view.copyWithin(0, hopSize, windowSize);
				const incoming = chunk.samples[ch];

				if (incoming) {
					view.set(incoming.subarray(0, chunkFrames), windowSize - hopSize);
				}

				if (chunkFrames < hopSize) {
					view.fill(0, windowSize - hopSize + chunkFrames, windowSize);
				}
			}
		} else {
			for (let ch = 0; ch < channels; ch++) {
				const view = scratch[ch]!;
				const incoming = chunk.samples[ch];

				if (incoming) view.set(incoming.subarray(0, chunkFrames), scratchFilled);
			}

			scratchFilled += chunkFrames;
			if (scratchFilled < windowSize) {
				for (let ch = 0; ch < channels; ch++) scratch[ch]!.fill(0, scratchFilled, windowSize);
				await onWindow(scratch, windowIndex);

				return;
			}
		}

		await onWindow(scratch, windowIndex);
		windowIndex++;

		if (chunkFrames < hopSize) return;
	}
}
