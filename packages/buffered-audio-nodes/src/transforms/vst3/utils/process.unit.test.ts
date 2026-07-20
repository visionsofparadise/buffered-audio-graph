import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_TAIL_BYTES, observeVstHostStderr } from "./process";

describe("observeVstHostStderr", () => {
	it("accumulates arbitrary stderr bytes", async () => {
		const stderr = new PassThrough();
		const getStderrTail = observeVstHostStderr(stderr);
		const ended = once(stderr, "end");

		stderr.write("ordinary ");
		stderr.write(Buffer.from("café\n"));
		stderr.end("incomplete final");
		stderr.resume();

		await ended;

		expect(getStderrTail()).toBe("ordinary café\nincomplete final");
	});

	it("retains the newest 64 KiB of diagnostic bytes", async () => {
		const stderr = new PassThrough();
		const getStderrTail = observeVstHostStderr(stderr);
		const ended = once(stderr, "end");
		const diagnostic = `old-prefix\n${"x".repeat(DIAGNOSTIC_TAIL_BYTES + 1024)}\n`;

		stderr.end(diagnostic);
		stderr.resume();

		await ended;

		const expected = Buffer.from(diagnostic).subarray(Buffer.byteLength(diagnostic) - DIAGNOSTIC_TAIL_BYTES).toString("utf8");

		expect(Buffer.byteLength(getStderrTail())).toBe(DIAGNOSTIC_TAIL_BYTES);
		expect(getStderrTail()).toBe(expected);
	});
});
