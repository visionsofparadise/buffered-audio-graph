import type { BlockBuffer } from "@buffered-audio/core";

async function scanStereo(
	buffer: BlockBuffer,
	channels: number,
	chunkFrames: number,
	visit: (channel: Float32Array, frames: number) => void,
): Promise<number> {
	let counted = 0;

	for (;;) {
		const chunk = await buffer.read(chunkFrames);
		const frames = chunk.samples[0]?.length ?? 0;

		if (frames === 0) break;

		const left = chunk.samples[0];
		const right = channels >= 2 ? chunk.samples[1] : chunk.samples[0];

		if (left) {
			visit(left, frames);

			counted += frames;
		}

		if (right) {
			visit(right, frames);

			counted += frames;
		}

		if (frames < chunkFrames) break;
	}

	return counted;
}

export async function computeStreamingStats(
	buffer: BlockBuffer,
	channels: number,
	chunkFrames: number,
): Promise<{ readonly mean: number; readonly std: number }> {
	await buffer.reset();

	let sum = 0;

	const count = await scanStereo(buffer, channels, chunkFrames, (channel, frames) => {
		for (let index = 0; index < frames; index++) sum += channel[index] ?? 0;
	});

	const mean = count > 0 ? sum / count : 0;

	await buffer.reset();

	let variance = 0;

	const varCount = await scanStereo(buffer, channels, chunkFrames, (channel, frames) => {
		for (let index = 0; index < frames; index++) {
			const diff = (channel[index] ?? 0) - mean;

			variance += diff * diff;
		}
	});

	const std = varCount > 0 ? Math.sqrt(variance / varCount) || 1 : 1;

	return { mean, std };
}
