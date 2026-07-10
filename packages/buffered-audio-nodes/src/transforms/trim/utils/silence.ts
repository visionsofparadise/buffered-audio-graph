export function findFirstAbove(samples: Array<Float32Array>, frames: number, threshold: number): number {
	for (let index = 0; index < frames; index++) {
		for (const channel of samples) {
			if (Math.abs(channel[index] ?? 0) > threshold) {
				return index;
			}
		}
	}

	return frames;
}

export function findLastAbove(samples: Array<Float32Array>, frames: number, threshold: number): number {
	for (let index = frames - 1; index >= 0; index--) {
		for (const channel of samples) {
			if (Math.abs(channel[index] ?? 0) > threshold) {
				return index;
			}
		}
	}

	return 0;
}

export function computeTrimRegion(firstAbove: number, lastAbove: number, frames: number, marginFrames: number, start: boolean, end: boolean): { startFrame: number; endFrame: number } | undefined {
	if (firstAbove >= frames) return undefined;

	const startFrame = start ? Math.max(0, firstAbove - marginFrames) : 0;
	const endFrame = end ? Math.min(frames, lastAbove + 1 + marginFrames) : frames;

	if (startFrame >= endFrame) return undefined;

	return { startFrame, endFrame };
}
