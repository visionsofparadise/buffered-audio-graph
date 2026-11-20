import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendTail, childExitError, decodeTail, terminateChild } from "./child-process";
import type { ChildProcess } from "node:child_process";

function createChild(exitsOn: ReadonlyArray<string>): {
	readonly child: ChildProcess;
	readonly kill: ReturnType<typeof vi.fn>;
	readonly exit: () => void;
} {
	const child = new EventEmitter();
	let exitCode: number | null = null;
	const exit = (): void => {
		exitCode = 1;
		child.emit("exit", 1, null);
	};
	const kill = vi.fn((signal: string) => {
		if (exitsOn.includes(signal)) exit();

		return true;
	});

	Object.defineProperties(child, {
		exitCode: { get: () => exitCode },
		signalCode: { value: null },
		kill: { value: kill },
	});

	return { child: child as unknown as ChildProcess, kill, exit };
}

function tracked(promise: Promise<void>): { readonly settled: () => boolean } {
	let settled = false;

	void promise.then(() => {
		settled = true;
	});

	return { settled: () => settled };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("terminateChild", () => {
	it("settles on exit after SIGTERM and never escalates once the grace has passed", async () => {
		vi.useFakeTimers();

		const { child, kill } = createChild(["SIGTERM"]);

		await terminateChild(child, { graceMs: 2000 });
		await vi.advanceTimersByTimeAsync(3000);

		expect(kill.mock.calls).toEqual([["SIGTERM"]]);
	});

	it("escalates to SIGKILL after the grace period, then settles on exit or 1000 ms after the kill", async () => {
		vi.useFakeTimers();

		const exiting = createChild([]);
		const exitingTermination = tracked(terminateChild(exiting.child, { graceMs: 2000 }));

		await vi.advanceTimersByTimeAsync(2000);

		expect(exiting.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(exitingTermination.settled()).toBe(false);

		await vi.advanceTimersByTimeAsync(500);
		exiting.exit();
		await vi.advanceTimersByTimeAsync(0);

		expect(exitingTermination.settled()).toBe(true);

		const silent = createChild([]);
		const silentTermination = tracked(terminateChild(silent.child, { graceMs: 2000 }));

		await vi.advanceTimersByTimeAsync(2999);

		expect(silentTermination.settled()).toBe(false);

		await vi.advanceTimersByTimeAsync(1);

		expect(silentTermination.settled()).toBe(true);
		expect(silent.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
	});

	it("kills with SIGKILL alone when firstSignal is SIGKILL, and settles on exit", async () => {
		vi.useFakeTimers();

		const { child, kill } = createChild(["SIGKILL"]);

		await terminateChild(child, { firstSignal: "SIGKILL" });
		await vi.advanceTimersByTimeAsync(3000);

		expect(kill.mock.calls).toEqual([["SIGKILL"]]);
	});
});

describe("childExitError", () => {
	it("quotes the last 1024 characters of a long stderr", () => {
		const stderr = Array.from({ length: 4000 }, (_, index) => String.fromCharCode(65 + (index % 26))).join("");
		const error = childExitError("tool", { code: 2, signal: null }, stderr);

		expect(error?.message).toBe(`tool exited 2: ${stderr.slice(-1024)}`);
	});

	it("reads a signal exit as the signal", () => {
		expect(childExitError("tool", { code: null, signal: "SIGTERM" }, "")?.message).toBe(
			"tool exited with signal SIGTERM",
		);
	});

	it("reads a spawn error as a failure to start", () => {
		const spawnError = new Error("spawn tool ENOENT");
		const error = childExitError("tool", { code: null, signal: null, spawnError }, "ignored");

		expect(error?.message).toBe("tool failed to start: spawn tool ENOENT");
		expect(error?.cause).toBe(spawnError);
	});
});

describe("appendTail", () => {
	it("keeps exactly the last limit bytes across many appends", () => {
		const source = Buffer.alloc(70000);

		for (let index = 0; index < source.length; index++) source[index] = (index * 7 + (index >> 9)) & 0xff;

		let tail: Buffer = Buffer.alloc(0);

		for (let offset = 0; offset < source.length; offset += 7000) {
			tail = appendTail(tail, source.subarray(offset, offset + 7000), 65536);
		}

		expect(tail.equals(source.subarray(source.length - 65536))).toBe(true);
	});
});

describe("decodeTail", () => {
	it.each([
		["é", "café au lait", Buffer.from("café au lait").indexOf(0xa9)],
		["a 4-byte emoji", "rocket 🚀 launched", Buffer.from("rocket 🚀 launched").indexOf(0x9f)],
	])("drops a leading partial %s from a truncated tail", (_name, text, cut) => {
		const decoded = decodeTail(Buffer.from(text).subarray(cut), true);

		expect(decoded).not.toContain("�");
		expect(text.endsWith(decoded)).toBe(true);
		expect(decoded.length).toBeGreaterThan(0);
	});

	it("decodes an untruncated tail unchanged", () => {
		expect(decodeTail(Buffer.from("ordinary café\n"), false)).toBe("ordinary café\n");
	});
});
