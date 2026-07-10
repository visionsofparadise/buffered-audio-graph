export const CHUNK_FRAMES = 44100;

export function silenceChunkSizes(total: number, chunkFrames: number): Array<number> {
	const sizes: Array<number> = [];
	let remaining = total;

	while (remaining > 0) {
		const take = Math.min(chunkFrames, remaining);

		sizes.push(take);
		remaining -= take;
	}

	return sizes;
}
