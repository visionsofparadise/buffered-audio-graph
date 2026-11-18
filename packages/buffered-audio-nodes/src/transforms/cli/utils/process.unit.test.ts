import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateChild } from "./process";
import type { ChildProcess } from "node:child_process";

function createChild(exitsOn: ReadonlyArray<string>): {
	readonly child: ChildProcess;
	readonly kill: ReturnType<typeof vi.fn>;
} {
	const child = new EventEmitter();
	let exitCode: number | null = null;
	const kill = vi.fn((signal: string) => {
		if (exitsOn.includes(signal)) {
			exitCode = 1;
			child.emit("exit", null, signal);
		}

		return true;
	});

	Object.defineProperties(child, {
		exitCode: { get: () => exitCode },
		signalCode: { value: null },
		kill: { value: kill },
	});

	return { child: child as unknown as ChildProcess, kill };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("terminateChild", () => {
	it("settles on exit after SIGTERM without escalating", async () => {
		const { child, kill } = createChild(["SIGTERM"]);

		await terminateChild(child);

		expect(kill.mock.calls).toEqual([["SIGTERM"]]);
	});

	it("escalates to SIGKILL after the grace period and settles without waiting for an exit", async () => {
		vi.useFakeTimers();

		const { child, kill } = createChild([]);
		const terminating = terminateChild(child, 2000);

		await vi.advanceTimersByTimeAsync(2000);
		await terminating;

		expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
	});
});
