export interface InsertOverlap {
	overlapStart: number;
	overlapEnd: number;
	insertOffset: number;
}

export function computeInsertOverlap(chunkStart: number, chunkFrames: number, insertAt: number, insertLength: number): InsertOverlap | undefined {
	const chunkEnd = chunkStart + chunkFrames;
	const insertEnd = insertAt + insertLength;

	if (chunkEnd <= insertAt || chunkStart >= insertEnd) return undefined;

	return {
		overlapStart: Math.max(0, insertAt - chunkStart),
		overlapEnd: Math.min(chunkFrames, insertEnd - chunkStart),
		insertOffset: Math.max(0, chunkStart - insertAt),
	};
}

export function applyInsert(destChannel: Float32Array, insertChannel: Float32Array, overlap: InsertOverlap): void {
	for (let frame = overlap.overlapStart; frame < overlap.overlapEnd; frame++) {
		const insertSample = insertChannel[overlap.insertOffset + frame - overlap.overlapStart];

		if (insertSample !== undefined) {
			destChannel[frame] = insertSample;
		}
	}
}
