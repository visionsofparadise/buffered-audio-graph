import { describe, expect, it, vi } from "vitest";
import { runJobs } from "./run-jobs";

describe("runJobs", () => {
	it("aborts the siblings of a failed job and settles every job before it rejects", async () => {
		const failing = {
			render: () =>
				new Promise<void>((_resolve, reject) => {
					setTimeout(() => {
						reject(new Error("a failed"));
					}, 50);
				}),
			abort: vi.fn(),
		};
		let abortSibling: () => void = () => undefined;
		let siblingSettled = false;
		const sibling = {
			render: () =>
				new Promise<void>((_resolve, reject) => {
					abortSibling = () => {
						setTimeout(() => {
							siblingSettled = true;
							reject(new DOMException("This operation was aborted", "AbortError"));
						}, 20);
					};
				}),
			abort: vi.fn(() => {
				abortSibling();
			}),
		};

		const outcome = runJobs([failing, sibling], new AbortController().signal).then(
			() => ({ settled: "fulfilled", siblingSettled }),
			(error: unknown) => ({ settled: "rejected", error, siblingSettled }),
		);

		await expect(outcome).resolves.toMatchObject({
			settled: "rejected",
			error: new Error("a failed"),
			siblingSettled: true,
		});
		expect(sibling.abort).toHaveBeenCalledTimes(1);
	});
});
