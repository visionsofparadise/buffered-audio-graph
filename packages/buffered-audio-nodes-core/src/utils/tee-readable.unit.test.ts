import { describe, expect, it } from "vitest";
import type { Block } from "../node/stream/block";
import { createBlock } from "../testing/blocks";
import { teeReadable } from "./tee-readable";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function isPending(promise: Promise<unknown>): Promise<boolean> {
	const sentinel = Symbol("pending");

	await tick();

	return (await Promise.race([promise, Promise.resolve(sentinel)])) === sentinel;
}

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

function teeBranches(readable: ReadableStream<Block>, count: number): Array<ReadableStream<Block>> {
	const items = Array.from({ length: count }, (_, index) => `branch-${index}`);
	const pairs = teeReadable(readable, items);

	expect(pairs.map(([, item]) => item)).toEqual(items);

	return pairs.map(([branch]) => branch);
}

function branchAt(branches: Array<ReadableStream<Block>>, offset: number): ReadableStream<Block> {
	const branch = branches[offset];

	if (!branch) throw new Error(`teeReadable returned no branch at ${offset}`);

	return branch;
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

	it("pulls upstream at the pace of the slowest branch", async () => {
		const blocks = createBlocks(3);
		const { readable, getAdvances } = createSource(blocks);
		const branches = teeBranches(readable, 2);
		const readerA = branchAt(branches, 0).getReader();
		const readerB = branchAt(branches, 1).getReader();

		expect((await readerA.read()).value).toBe(blocks[0]);
		await tick();

		// One pull serves the read; the source's own highWaterMark-1 queue prefetches at most one more.
		expect(getAdvances()).toBeLessThanOrEqual(2);

		const advancesBefore = getAdvances();
		const secondA = readerA.read();

		expect(await isPending(secondA)).toBe(true);
		expect(getAdvances()).toBe(advancesBefore);

		expect((await readerB.read()).value).toBe(blocks[0]);
		expect((await secondA).value).toBe(blocks[1]);
		expect((await readerB.read()).value).toBe(blocks[1]);
	});

	it("enqueues the same block reference to every branch", async () => {
		const { readable } = createSource(createBlocks(1));
		const branches = teeBranches(readable, 2);

		const [readA, readB] = await Promise.all([branchAt(branches, 0).getReader().read(), branchAt(branches, 1).getReader().read()]);

		expect(readA.value).toBe(readB.value);
	});

	it("lets the remaining branches drain after one branch cancels", async () => {
		const blocks = createBlocks(3);
		const { readable, cancelReasons } = createSource(blocks);
		const branches = teeBranches(readable, 2);

		await branchAt(branches, 0).cancel("done early");

		const readerB = branchAt(branches, 1).getReader();
		const received: Array<Block> = [];

		for (;;) {
			const { done, value } = await readerB.read();

			if (done) break;

			received.push(value);
		}

		expect(received).toEqual(blocks);
		expect(cancelReasons).toEqual([]);
	});

	it("cancels upstream once every branch has cancelled", async () => {
		const { readable, cancelReasons } = createSource(createBlocks(3));
		const branches = teeBranches(readable, 2);

		await branchAt(branches, 0).cancel("a gone");
		await branchAt(branches, 1).cancel("b gone");

		expect(cancelReasons).toEqual(["b gone"]);
	});

	it("propagates an upstream error to every branch", async () => {
		const { readable } = createSource(createBlocks(3), 2);
		const branches = teeBranches(readable, 2);
		const readerA = branchAt(branches, 0).getReader();
		const readerB = branchAt(branches, 1).getReader();

		await readerA.read();
		await readerB.read();

		const pendingA = readerA.read();
		const pendingB = readerB.read();

		await expect(pendingA).rejects.toThrow("source failed");
		await expect(pendingB).rejects.toThrow("source failed");
	});

	it("advances upstream only when all three branches demand", async () => {
		const blocks = createBlocks(3);
		const { readable, getAdvances } = createSource(blocks);
		const branches = teeBranches(readable, 3);
		const readerA = branchAt(branches, 0).getReader();
		const readerB = branchAt(branches, 1).getReader();
		const readerC = branchAt(branches, 2).getReader();

		await readerA.read();
		await readerB.read();
		await tick();

		const advancesBefore = getAdvances();

		expect((await readerC.read()).value).toBe(blocks[0]);
		await tick();

		expect(getAdvances()).toBe(advancesBefore + 1);
	});
});
