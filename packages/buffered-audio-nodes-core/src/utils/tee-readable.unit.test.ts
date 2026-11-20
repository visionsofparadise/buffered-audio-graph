import { describe, expect, it } from "vitest";
import type { Block } from "../node/stream/block";
import { createBlock } from "../testing/blocks";
import { teeReadable } from "./tee-readable";

function createBlocks(count: number): Array<Block> {
	return Array.from({ length: count }, (_, index) => createBlock(index, index * 4, 4));
}

function createSource(blocks: Array<Block>, failAtAdvance?: number) {
	const cancelReasons: Array<unknown> = [];

	let advances = 0;
	let offset = 0;

	const readable = new ReadableStream<Block>({
		pull: async (controller) => {
			advances += 1;

			if (advances === failAtAdvance) throw new Error("source failed");

			const block = blocks[offset];

			if (!block) {
				controller.close();

				return;
			}

			controller.enqueue(block);
			offset += 1;
		},
		cancel: (reason) => {
			cancelReasons.push(reason);
		},
	});

	return { readable, cancelReasons, getAdvances: () => advances };
}

describe("teeReadable", () => {
	it("returns no pairs for no items", () => {
		const { readable } = createSource(createBlocks(1));

		expect(teeReadable(readable, [])).toEqual([]);
	});

	it("passes the readable through untouched for a single item", () => {
		const { readable } = createSource(createBlocks(1));

		expect(teeReadable(readable, ["only"])).toEqual([[readable, "only"]]);
	});
});
