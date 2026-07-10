import type { CutRegion } from "..";

export interface KeepRange {
	start: number;
	end: number;
}

export function computeKeepRanges(sortedRegions: Array<CutRegion>, chunkStartSec: number, sampleRate: number, chunkFrames: number): Array<KeepRange> {
	const keepRanges: Array<KeepRange> = [];
	let cursor = 0;

	for (const region of sortedRegions) {
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

	return keepRanges;
}
