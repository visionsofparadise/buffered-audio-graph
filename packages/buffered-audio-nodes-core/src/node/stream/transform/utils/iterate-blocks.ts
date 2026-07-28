import type { Block } from "../../block";

interface BlockReader {
	read: (frames: number) => Promise<Block>;
}

export async function* iterateBlocks(reader: BlockReader, frames: number): AsyncIterableIterator<Block> {
	for (;;) {
		const block = await reader.read(frames);

		if ((block.samples[0]?.length ?? 0) === 0) return;

		yield block;
	}
}
