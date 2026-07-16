import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_TAIL_BYTES, observeVstHostStderr, parseVstHostEvent } from "./process";

const activeLine = 'VST_HOST_EVENT {"type":"liveness","phase":"process","elapsedMs":30000,"processCpuDeltaMs":25000,"processCpuMs":26000,"state":"active"}';

describe("parseVstHostEvent", () => {
	it("accepts the locked liveness shape", () => {
		expect(parseVstHostEvent(activeLine)).toEqual({
			type: "liveness",
			phase: "process",
			elapsedMs: 30_000,
			processCpuDeltaMs: 25_000,
			processCpuMs: 26_000,
			state: "active",
		});
	});

	it.each([
		"ordinary diagnostic",
		"VST_HOST_EVENT {malformed}",
		'VST_HOST_EVENT {"type":"progress","phase":"process","elapsedMs":1,"processCpuDeltaMs":1,"processCpuMs":1,"state":"active"}',
		'VST_HOST_EVENT {"type":"liveness","phase":"load","elapsedMs":1,"processCpuDeltaMs":1,"processCpuMs":1,"state":"active"}',
		'VST_HOST_EVENT {"type":"liveness","phase":"process","elapsedMs":-1,"processCpuDeltaMs":1,"processCpuMs":1,"state":"active"}',
		'VST_HOST_EVENT {"type":"liveness","phase":"process","elapsedMs":1,"processCpuDeltaMs":1,"processCpuMs":1,"state":"unknown"}',
	])("rejects invalid telemetry: %s", (line) => {
		expect(parseVstHostEvent(line)).toBeUndefined();
	});
});

describe("observeVstHostStderr", () => {
	it("assembles split UTF-8 lines, forwards valid telemetry, and preserves diagnostics", async () => {
		const stderr = new PassThrough();
		const events: Array<ReturnType<typeof parseVstHostEvent>> = [];
		const getStderrTail = observeVstHostStderr(stderr, (event) => events.push(event));
		const ended = once(stderr, "end");
		const splitAt = activeLine.indexOf("processCpuDeltaMs");

		stderr.write(activeLine.slice(0, splitAt));
		stderr.write(`${activeLine.slice(splitAt)}\nordinary café\n`);
		stderr.write("VST_HOST_EVENT {malformed}\n");
		stderr.end("incomplete final");
		stderr.resume();

		await ended;

		expect(events).toEqual([parseVstHostEvent(activeLine)]);
		expect(getStderrTail()).toBe("ordinary café\nVST_HOST_EVENT {malformed}\nincomplete final");
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
