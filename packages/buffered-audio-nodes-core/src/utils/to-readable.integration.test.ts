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
