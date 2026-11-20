import { describe, expect, it } from "vitest";
import type { Block } from "../node/stream/block";
import { createBlock } from "../testing/blocks";
import { assertFirstBlockSampleRate } from "./assert-first-block-sample-rate";

interface TestSource {
	readonly readable: ReadableStream<Block>;
	advances(): number;
	cancelled(): boolean;
	cancelReason(): unknown;
}

function sourceOf(rates: Array<number>): TestSource {
	let advances = 0;
	let cancelled = false;
	let cancelReason: unknown;
	let index = 0;

	const readable = new ReadableStream<Block>({
		pull: (controller) => {
			const rate = rates[index];

			if (rate === undefined) {
				controller.close();

				return;
			}

			advances += 1;
			controller.enqueue(createBlock(1, index * 10, 10, { sampleRate: rate }));
			index += 1;
		},
		cancel: (reason) => {
			cancelled = true;
			cancelReason = reason;
		},
	});

	return { readable, advances: () => advances, cancelled: () => cancelled, cancelReason: () => cancelReason };
}

describe("assertFirstBlockSampleRate", () => {
	it("forwards one upstream read per pull", async () => {
		const source = sourceOf([44100, 44100, 44100, 44100, 44100]);
		const reader = assertFirstBlockSampleRate(source.readable, 44100, "gain").getReader();

		await reader.read();

		// One pull serves the read; the upstream and wrapper queues each prefetch at most one more.
		expect(source.advances()).toBeLessThanOrEqual(3);

		for (;;) {
			if ((await reader.read()).done) break;
		}

		expect(source.advances()).toBe(5);
	});

	it("delivers every block in order when the rate matches", async () => {
		const source = sourceOf([48000, 48000, 48000]);
		const reader = assertFirstBlockSampleRate(source.readable, 48000, "gain").getReader();
		const offsets: Array<number> = [];

		for (;;) {
			const { done, value } = await reader.read();

			if (done) break;

			offsets.push(value.offset);
		}

		expect(offsets).toEqual([0, 10, 20]);
	});

	it("errors naming the node when the first block's rate differs", async () => {
		const source = sourceOf([48000, 48000]);
		const reader = assertFirstBlockSampleRate(source.readable, 44100, "resample").getReader();

		await expect(reader.read()).rejects.toThrow(/^resample: emitted 48000 Hz where 44100 Hz was declared/);
	});

	it("cancels upstream on a rate mismatch", async () => {
		const source = sourceOf([22050, 22050, 22050]);
		const reader = assertFirstBlockSampleRate(source.readable, 44100, "resample").getReader();

		await expect(reader.read()).rejects.toThrow();
		expect(source.cancelled()).toBe(true);
	});

	it("closes cleanly on an empty stream", async () => {
		const source = sourceOf([]);
		const reader = assertFirstBlockSampleRate(source.readable, 44100, "gain").getReader();

		expect((await reader.read()).done).toBe(true);
	});

	it("propagates the cancel reason upstream", async () => {
		const source = sourceOf([44100, 44100]);
		const reader = assertFirstBlockSampleRate(source.readable, 44100, "gain").getReader();

		await reader.read();
		await reader.cancel("downstream done");

		expect(source.cancelReason()).toBe("downstream done");
	});
});
