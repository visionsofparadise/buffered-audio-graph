import type { Block } from "../node/stream/block";

export function teeReadable<T>(readable: ReadableStream<Block>, items: ReadonlyArray<T>): Array<[ReadableStream<Block>, T]> {
	if (items.length === 0) return [];

	const first = items[0] as T;

	if (items.length === 1) return [[readable, first]];

	const pairs: Array<[ReadableStream<Block>, T]> = [];

	let current = readable;

	for (let offset = 0; offset < items.length - 1; offset++) {
		const [left, right] = current.tee();

		pairs.push([left, items[offset] as T]);
		current = right;
	}

	pairs.push([current, items[items.length - 1] as T]);

	return pairs;
}
