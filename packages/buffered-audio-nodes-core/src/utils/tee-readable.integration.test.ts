import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import type { Block } from "../node/stream/block";
import { createBlock } from "../testing/blocks";
import { teeReadable } from "./tee-readable";

function createSource(count: number): {
	readonly readable: ReadableStream<Block>;
	readonly cancelReasons: Array<unknown>;
} {
	const blocks = Array.from({ length: count }, (_, index) => createBlock(index, index * 4, 4));
	const cancelReasons: Array<unknown> = [];
	let offset = 0;
	const readable = new ReadableStream<Block>({
		pull: (controller) => {
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

	return { readable, cancelReasons };
}

describe("teeReadable abort signal", () => {
	it("errors every branch with the signal's reason and cancels upstream on abort", async () => {
		const { readable, cancelReasons } = createSource(3);
		const controller = new AbortController();
		const pairs = teeReadable(readable, ["a", "b"], controller.signal);
		const [readerA, readerB] = pairs.map(([branch]) => branch.getReader());
		const reason = new Error("render aborted");

		controller.abort(reason);

		await expect(readerA?.read()).rejects.toBe(reason);
		await expect(readerB?.read()).rejects.toBe(reason);
		expect(cancelReasons).toEqual([reason]);
	});

	it("errors every branch at once when the signal has already aborted", async () => {
		const { readable } = createSource(3);
		const controller = new AbortController();
		const reason = new Error("render aborted");

		controller.abort(reason);

		const pairs = teeReadable(readable, ["a", "b"], controller.signal);

		for (const [branch] of pairs) await expect(branch.getReader().read()).rejects.toBe(reason);
	});

	it("removes its abort listener once upstream ends", async () => {
		const { readable } = createSource(1);
		const controller = new AbortController();
		const pairs = teeReadable(readable, ["a", "b"], controller.signal);
		const readers = pairs.map(([branch]) => branch.getReader());

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

		for (;;) {
			const results = await Promise.all(readers.map((reader) => reader.read()));

			if (results.every((result) => result.done)) break;
		}

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("removes its abort listener once every branch has cancelled", async () => {
		const { readable } = createSource(3);
		const controller = new AbortController();
		const pairs = teeReadable(readable, ["a", "b"], controller.signal);

		for (const [branch] of pairs) await branch.cancel("gone");

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
