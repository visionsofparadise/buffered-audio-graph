import type { Block } from "../node/stream/block";

export function readableFrom(blocks: Array<Block>): ReadableStream<Block> {
	let index = 0;

	return new ReadableStream<Block>({
		pull: (controller) => {
			const block = blocks[index];

			if (block) {
				index += 1;
				controller.enqueue(block);
			} else {
				controller.close();
			}
		},
	});
}

export async function drainBlocks(readable: ReadableStream<Block>): Promise<Array<Block>> {
	const out: Array<Block> = [];
	const reader = readable.getReader();

	for (;;) {
		const { done, value } = await reader.read();

		if (done) break;

		out.push(value);
	}

	return out;
}
