import { describe, expect, it, vi } from "vitest";
import { toReadable } from "./to-readable";

describe("toReadable cancel", () => {
	it("runs onCancel before return() while next() is pending, so the hook can settle the pending call", async () => {
		const calls: Array<string> = [];
		let release: (() => void) | undefined;

		async function* parked(): AsyncGenerator<number> {
			try {
				await new Promise<void>((resolve) => {
					release = resolve;
				});

				yield 1;
			} finally {
				calls.push("return");
			}
		}

		const reader = toReadable(parked(), {
			onCancel: () => {
				calls.push("onCancel");
				release?.();
			},
		}).getReader();
		const pending = reader.read();

		await vi.waitFor(() => expect(release).toBeDefined());

		// return() queues behind the pending next(), so the cancel resolves only because onCancel releases it.
		await reader.cancel();

		expect(calls).toEqual(["onCancel", "return"]);
		expect((await pending).done).toBe(true);
	});
});
