import { describe, expect, it, vi } from "vitest";
import { toReadable } from "./to-readable";

describe("toReadable cancel", () => {
	it("runs onCancel before return()", async () => {
		const order: Array<string> = [];
		let settleNext: ((result: IteratorResult<number>) => void) | undefined;
		const iterator: AsyncIterator<number> = {
			next: () =>
				new Promise((resolve) => {
					settleNext = resolve;
				}),
			return: () => {
				order.push("return");

				return Promise.resolve({ done: true, value: undefined });
			},
		};

		const reader = toReadable(iterator, {
			onCancel: () => {
				order.push("onCancel");
			},
		}).getReader();

		await vi.waitFor(() => expect(settleNext).toBeDefined());
		await reader.cancel();

		expect(order).toEqual(["onCancel", "return"]);
	});

	it("lets onCancel settle a pending next() that return() queues behind", async () => {
		let release: (() => void) | undefined;
		let finallyRan = false;

		async function* parked(): AsyncGenerator<number> {
			try {
				await new Promise<void>((resolve) => {
					release = resolve;
				});

				yield 1;
			} finally {
				finallyRan = true;
			}
		}

		const reader = toReadable(parked(), { onCancel: () => release?.() }).getReader();
		const pending = reader.read();

		await vi.waitFor(() => expect(release).toBeDefined());

		// An async generator queues return() behind the pending next(), so this cancel resolves only because onCancel releases it.
		await reader.cancel();

		expect(finallyRan).toBe(true);
		expect((await pending).done).toBe(true);
	});
});

describe("toReadable", () => {
	it("advances the source iterator once per delivered value", async () => {
		let advances = 0;

		async function* counter(): AsyncGenerator<number> {
			for (let value = 0; value < 5; value += 1) {
				advances += 1;

				yield value;
			}
		}

		const reader = toReadable(counter()).getReader();
		const first = await reader.read();

		expect(first.value).toBe(0);
		// One pull serves the read; the default highWaterMark-1 queue prefetches at most one more.
		expect(advances).toBeLessThanOrEqual(2);

		const values = [first.value];

		for (;;) {
			const { done, value } = await reader.read();

			if (done) break;

			values.push(value);
		}

		expect(values).toEqual([0, 1, 2, 3, 4]);
		expect(advances).toBe(5);
	});

	it("closes the stream when the generator completes", async () => {
		async function* two(): AsyncGenerator<number> {
			yield 1;
			yield 2;
		}

		const reader = toReadable(two()).getReader();

		expect((await reader.read()).value).toBe(1);
		expect((await reader.read()).value).toBe(2);
		expect((await reader.read()).done).toBe(true);
	});

	it("runs the generator's finally on cancel", async () => {
		let finallyRan = false;

		async function* infinite(): AsyncGenerator<number> {
			try {
				for (let value = 0; ; value += 1) yield value;
			} finally {
				finallyRan = true;
			}
		}

		const reader = toReadable(infinite()).getReader();

		await reader.read();
		await reader.cancel();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(finallyRan).toBe(true);
	});
});
