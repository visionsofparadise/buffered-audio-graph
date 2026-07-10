import { describe, expect, it } from "vitest";
import { toReadable } from "./to-readable";

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
