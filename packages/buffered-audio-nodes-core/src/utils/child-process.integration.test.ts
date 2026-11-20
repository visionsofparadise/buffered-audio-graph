import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	boundAfterExit,
	childFailure,
	ChildOutputBuffer,
	ChildOutputHeldError,
	releaseChild,
	runChild,
	settledOrAborted,
	spawnChild,
	terminateChild,
	waitForChildClose,
	writeChildInput,
	type ChildHandle,
} from "./child-process";

const isWindows = process.platform === "win32";
const HOLDER_SCRIPT = "setInterval(function(){console.log('holder')},500);setTimeout(function(){process.exit()},6000)";
const directories: Array<string> = [];

afterAll(async () => {
	await Promise.all(
		directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
	);
});

// Pid files of children that ignore SIGTERM and never exit on their own; any still running after a test is killed.
const survivorPidFiles: Array<string> = [];

afterEach(async () => {
	for (const pidFile of survivorPidFiles.splice(0)) {
		const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));

		if (!pid) continue;

		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "child-process-test-"));

	directories.push(directory);

	return directory;
}

function node(script: string, ...args: Array<string>): ChildHandle {
	return spawnChild({ label: "node", command: process.execPath, args: ["-e", script, ...args] });
}

async function windowsCommandFile(lines: ReadonlyArray<string>): Promise<Array<string>> {
	const file = join(await temporaryDirectory(), "holder.cmd");

	await writeFile(file, `${lines.join("\r\n")}\r\n`);

	return ["/d", "/c", file];
}

function windowsHolder(code: number, script = HOLDER_SCRIPT): Promise<Array<string>> {
	return windowsCommandFile([`@start /b "" "${process.execPath}" -e "${script}"`, "@echo bad 1>&2", `@exit ${code}`]);
}

async function heldStdout(code: number): Promise<{ readonly command: string; readonly args: Array<string> }> {
	if (isWindows) return { command: "cmd.exe", args: await windowsHolder(code) };

	return { command: "sh", args: ["-c", code === 0 ? "sleep 6 & exit 0" : `sleep 6 & echo bad >&2; exit ${code}`] };
}

async function writingHolder(code: number): Promise<{ readonly command: string; readonly args: Array<string> }> {
	if (isWindows) return { command: "cmd.exe", args: await windowsHolder(code) };

	return {
		command: "sh",
		args: [
			"-c",
			`(sleep 0.5; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo holder; sleep 0.5; done) & echo bad >&2; exit ${code}`,
		],
	};
}

async function briefHolder(): Promise<{ readonly command: string; readonly args: Array<string> }> {
	if (isWindows) return { command: "cmd.exe", args: await windowsHolder(0, "setTimeout(function(){},1000)") };

	return { command: "sh", args: ["-c", "sleep 1 & exit 0"] };
}

function exitTime(handle: ChildHandle): Promise<number> {
	return handle.exited.then(() => performance.now());
}

function stdoutEnd(handle: ChildHandle): Promise<void> {
	const stdout = handle.stdout;

	if (!stdout) throw new Error("no stdout");

	const ended = once(stdout, "end").then(() => undefined);

	stdout.resume();

	return ended;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readyLine(handle: ChildHandle): Promise<void> {
	return new Promise((resolve) => {
		const onData = (chunk: Buffer): void => {
			if (!chunk.toString().includes("ready")) return;

			handle.stdout?.off("data", onData);
			resolve();
		};

		handle.stdout?.on("data", onData);
	});
}

async function settleOrNull<T>(promise: Promise<T>): Promise<T | Error> {
	return promise.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
}

async function writeUntilRejected(handle: ChildHandle, signal?: AbortSignal): Promise<void> {
	for (let index = 0; index < 64; index++) await writeChildInput(handle, Buffer.alloc(1024 * 1024), signal);

	throw new Error("writeChildInput never rejected");
}

describe("spawnChild", () => {
	it("throws a labelled failure to start for a NUL byte in an argument", () => {
		expect(() => node("", "bad\0argument")).toThrow(/^node failed to start: /);
	});

	it("settles exited and closed with the spawn error for a missing command, with nothing uncaught", async () => {
		const uncaught = vi.fn();

		process.on("uncaughtException", uncaught);

		try {
			const command = join(tmpdir(), "missing-child-process-command");
			const handle = spawnChild({ label: "missing", command, args: [] });
			const exit = await handle.exited;
			const closed = await handle.closed;

			expect(exit.spawnError).toBeInstanceOf(Error);
			expect(exit.code).toBeNull();
			expect(closed.spawnError).toBe(exit.spawnError);

			await delay(50);

			expect(uncaught).not.toHaveBeenCalled();

			const result = await runChild({ label: "missing", command, args: [] });

			expect(result.exit.spawnError).toBeInstanceOf(Error);
			expect(result.failure?.message).toMatch(/failed to start/);
		} finally {
			process.off("uncaughtException", uncaught);
		}
	});

	it("leaves stdinError undefined when writing to a child that has exited", async () => {
		const handle = node("process.exit(0)");

		await handle.exited;

		for (let index = 0; index < 4; index++) handle.stdin?.write(Buffer.alloc(65536));

		await delay(200);

		expect(handle.stdinError()).toBeUndefined();
		releaseChild(handle);
	});
});

describe("childFailure", () => {
	it("ends the error with the last characters of a large stderr", async () => {
		const handle = node(
			`process.stderr.write(Buffer.alloc(1048576, 65).toString() + "the very end", () => process.exit(2))`,
		);
		const failure = await childFailure(handle);

		expect(failure?.message).toMatch(/^node exited 2: A+the very end$/);
		expect(failure?.message.length).toBe("node exited 2: ".length + 1024);
	});

	it("drains unread stdout so the close wait ends promptly", async () => {
		const handle = node("process.stdout.write(Buffer.alloc(10240, 66), () => process.exit(1))");
		let closed = false;

		void handle.closed.then(() => {
			closed = true;
		});
		handle.stdout?.on("readable", () => undefined);

		const started = performance.now();
		const failure = await childFailure(handle);

		expect(performance.now() - started).toBeLessThan(2500);
		expect(closed).toBe(true);
		expect(failure?.message).toBe("node exited 1");
	});

	it("gives up on a child that never exits once exitWithinMs passes", async () => {
		const handle = node(`process.stdout.write("x".repeat(1000)); setInterval(() => undefined, 1000)`);

		try {
			const started = performance.now();
			const failure = await childFailure(handle, { exitWithinMs: 2000, discardOutput: true });
			const elapsed = performance.now() - started;

			expect(failure).toBeUndefined();
			expect(elapsed).toBeGreaterThanOrEqual(1990);
			expect(elapsed).toBeLessThan(3000);
		} finally {
			await terminateChild(handle.child);
			releaseChild(handle);
		}
	});
});

describe("runChild", () => {
	it("resolves a synchronous spawn throw with the raw spawn error, labelled once", async () => {
		const result = await runChild({ label: "tool", command: "tool\0name", args: [] });

		expect(result.exit.spawnError).toBeInstanceOf(Error);
		expect(result.exit.spawnError?.message).not.toMatch(/failed to start/);
		expect(result.failure?.message).toMatch(/failed to start/);
		expect(result.failure?.message.match(/failed to start/g)).toHaveLength(1);
		expect(result.stdout.length).toBe(0);
	});

	it("rejects at the timeout and leaves the child gone", async () => {
		const pidFile = join(await temporaryDirectory(), "pid");
		const script = `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)`;

		await expect(
			runChild({ label: "node", command: process.execPath, args: ["-e", script, pidFile], timeoutMs: 2000 }),
		).rejects.toThrow("node timed out after 2000 ms");

		const pid = Number(await readFile(pidFile, "utf8"));
		let probe: unknown;

		try {
			process.kill(pid, 0);
		} catch (error) {
			probe = error;
		}

		expect(probe).toHaveProperty("code", "ESRCH");
	});

	it("rejects with the signal's reason when aborted", async () => {
		const controller = new AbortController();
		const reason = new Error("stop the child");
		const running = runChild({
			label: "node",
			command: process.execPath,
			args: ["-e", "setInterval(() => undefined, 1000)"],
			signal: controller.signal,
		});

		setTimeout(() => controller.abort(reason), 200);

		await expect(running).rejects.toBe(reason);
	});

	it("rejects with a non-Error abort reason itself", async () => {
		const controller = new AbortController();
		const running = runChild({
			label: "node",
			command: process.execPath,
			args: ["-e", "setInterval(() => undefined, 1000)"],
			signal: controller.signal,
		});

		setTimeout(() => controller.abort("cancelled"), 200);

		await expect(running).rejects.toBe("cancelled");
	});

	it.skipIf(isWindows)("kills a child that ignores SIGTERM at once when aborted", async () => {
		const pidFile = join(await temporaryDirectory(), "pid");

		survivorPidFiles.push(pidFile);

		const script = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)`;
		const controller = new AbortController();
		const running = settleOrNull(
			runChild({
				label: "node",
				command: process.execPath,
				args: ["-e", script, pidFile],
				signal: controller.signal,
			}),
		);
		let pid = 0;

		while (!pid) {
			await delay(50);
			pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
		}

		const abortedAt = performance.now();

		controller.abort();

		expect(await running).toBe(controller.signal.reason);
		expect(performance.now() - abortedAt).toBeLessThan(1000);
		expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
	});

	it("rejects when stdout passes the cap", async () => {
		await expect(
			runChild({
				label: "node",
				command: process.execPath,
				args: ["-e", "process.stdout.write(Buffer.alloc(2 * 1024 * 1024)); setInterval(() => undefined, 1000)"],
				stdoutLimitBytes: 1024 * 1024,
			}),
		).rejects.toThrow("node wrote more than 1048576 bytes to stdout");
	});

	it("collects every byte of stdout written in several writes", async () => {
		const script = `let n = 0; const next = () => { if (n++ < 10) process.stdout.write(Buffer.alloc(10240, n), next); else process.exit(0); }; next()`;
		const result = await runChild({ label: "node", command: process.execPath, args: ["-e", script] });
		const expected = Buffer.concat(Array.from({ length: 10 }, (_, index) => Buffer.alloc(10240, index + 1)));

		expect(result.exit.code).toBe(0);
		expect(result.failure).toBeUndefined();
		expect(result.stdout.equals(expected)).toBe(true);
	});
});

describe("terminateChild against a real child", () => {
	it.skipIf(isWindows)(
		"waits for the reap after SIGKILL when the child ignores SIGTERM",
		async () => {
			for (let run = 0; run < 5; run++) {
				const handle = node(
					`process.on("SIGTERM", () => undefined); process.stdout.write("ready\\n"); setInterval(() => undefined, 1000)`,
				);

				await readyLine(handle);
				await terminateChild(handle.child);

				expect(handle.child.signalCode).toBe("SIGKILL");
				releaseChild(handle);
			}
		},
		30_000,
	);
});

describe("boundAfterExit", () => {
	it("resolves the stdout-end wait of a plain child", async () => {
		const handle = node("process.stdout.write(Buffer.alloc(262144, 67), () => process.exit(0))");

		await expect(boundAfterExit(handle, stdoutEnd(handle))).resolves.toBeUndefined();
	});

	async function expectHeld(command: string, args: Array<string>): Promise<void> {
		const handle = spawnChild({ label: "holder", command, args });
		const exitedAt = exitTime(handle);

		try {
			const error = await settleOrNull(boundAfterExit(handle, stdoutEnd(handle)));
			const sinceExit = performance.now() - (await exitedAt);

			expect(error).toBeInstanceOf(ChildOutputHeldError);
			expect(sinceExit).toBeGreaterThanOrEqual(1990);
			expect(sinceExit).toBeLessThan(3500);
		} finally {
			releaseChild(handle);
		}
	}

	it.skipIf(isWindows)(
		"rejects with ChildOutputHeldError when a grandchild holds stdout after a clean exit",
		async () => {
			await expectHeld("sh", ["-c", "sleep 6 & exit 0"]);
		},
	);

	it.skipIf(!isWindows)(
		"rejects with ChildOutputHeldError when a node grandchild holds stdout after a clean exit",
		async () => {
			await expectHeld("cmd.exe", await windowsHolder(0));
		},
	);

	it("rejects with a non-Error abort reason of its wait itself", async () => {
		const handle = node("setInterval(() => undefined, 1000)");
		const controller = new AbortController();

		try {
			const bounded = boundAfterExit(
				handle,
				settledOrAborted(new Promise<never>(() => undefined), controller.signal),
			);

			controller.abort("cancelled");

			await expect(bounded).rejects.toBe("cancelled");
		} finally {
			await terminateChild(handle.child);
			releaseChild(handle);
		}
	});

	it("reports a failed exit rather than the held stdout", async () => {
		const { command, args } = await heldStdout(3);
		const handle = spawnChild({ label: "holder", command, args });

		try {
			const error = await settleOrNull(boundAfterExit(handle, stdoutEnd(handle)));

			expect(error).not.toBeInstanceOf(ChildOutputHeldError);
			expect(error).toHaveProperty("message", expect.stringMatching(/exited 3/));
		} finally {
			releaseChild(handle);
		}
	});

	it("makes runChild reject a clean held exit and resolve a failed one", async () => {
		const clean = await heldStdout(0);

		await expect(runChild({ label: "holder", ...clean })).rejects.toBeInstanceOf(ChildOutputHeldError);

		const failed = await heldStdout(3);
		const result = await runChild({ label: "holder", ...failed });

		expect(result.failure?.message).toMatch(/exited 3/);
	});
});

describe("waitForChildClose", () => {
	it("leaves the final stderr line of a clean exit in the tail", async () => {
		for (let run = 0; run < 20; run++) {
			const handle = node(`process.stderr.write("final\\n"); process.exit(0)`);

			await handle.exited;
			await waitForChildClose(handle);

			expect(handle.stderrTail().trimEnd().endsWith("final")).toBe(true);
		}
	});
});

describe("ChildOutputBuffer", () => {
	it("hands out every byte in order through pull and take, and take(n) returns n bytes", async () => {
		const handle = node(
			"process.stdout.write(Buffer.from(Array.from({ length: 102400 }, (_, i) => i % 251)), () => process.exit(0))",
		);
		const buffer = new ChildOutputBuffer(handle);
		const parts: Array<Buffer> = [];

		try {
			while (buffer.length < 1000 && !buffer.ended) {
				buffer.pull();

				if (buffer.length < 1000 && !buffer.ended) await buffer.nextChange();
			}

			const first = buffer.take(1000);

			expect(first?.length).toBe(1000);

			if (first) parts.push(first);

			for (;;) {
				buffer.pull();

				const bytes = buffer.take();

				if (bytes) parts.push(bytes);
				else if (buffer.ended) break;
				else await buffer.nextChange();
			}

			const expected = Buffer.from(Array.from({ length: 102400 }, (_, index) => index % 251));

			expect(Buffer.concat(parts).equals(expected)).toBe(true);
		} finally {
			buffer.dispose();
		}
	});

	it("hands unshifted bytes out first", async () => {
		const handle = node(`process.stdout.write("abcdef", () => process.exit(0))`);
		const buffer = new ChildOutputBuffer(handle);

		try {
			while (!buffer.ended) {
				buffer.pull();
				await buffer.nextChange();
			}

			expect(buffer.take(2)?.toString()).toBe("ab");

			buffer.unshift(Buffer.from("xyz"));

			expect(buffer.take(3)?.toString()).toBe("xyz");
			expect(buffer.take()?.toString()).toBe("cdef");
		} finally {
			buffer.dispose();
		}
	});

	it("settles one shared change promise per event and replaces it", async () => {
		const handle = node(
			`process.stdin.once("data", () => process.stdout.write("hello")); setInterval(() => undefined, 1000)`,
		);
		const controller = new AbortController();
		const buffer = new ChildOutputBuffer(handle, { signal: controller.signal });

		try {
			const notified = buffer.nextChange();

			expect(buffer.nextChange()).toBe(notified);

			buffer.notify();
			await notified;

			const next = buffer.nextChange();
			let nextSettled = false;

			void next.then(() => {
				nextSettled = true;
			});
			await delay(20);

			expect(next).not.toBe(notified);
			expect(nextSettled).toBe(false);

			handle.stdin?.write("go");
			await next;
			buffer.pull();

			expect(buffer.take()?.toString()).toBe("hello");

			const aborted = buffer.nextChange();
			const reason = new Error("stop reading");

			controller.abort(reason);
			await aborted;

			expect(buffer.failure).toBe(reason);
		} finally {
			await terminateChild(handle.child);
			releaseChild(handle);
			buffer.dispose();
		}
	});

	it("settles the change promise on the exit and on the end of a stdout held past it", async () => {
		const { command, args } = await briefHolder();
		const handle = spawnChild({ label: "holder", command, args });
		const buffer = new ChildOutputBuffer(handle);

		try {
			while (handle.child.exitCode === null) await buffer.nextChange();

			expect(buffer.ended).toBe(false);

			for (;;) {
				const change = buffer.nextChange();

				if (buffer.ended) break;

				await change;
			}

			expect(buffer.ended).toBe(true);
			expect(buffer.failure).toBeUndefined();
		} finally {
			releaseChild(handle);
			buffer.dispose();
		}
	});

	it.each([
		[1, /exited 1: bad/],
		[0, /exited, but its stdout stayed open for 2000 ms/],
	])(
		"fails at the deadline after exit %i, exit first, and releases nothing pulled after it",
		async (code, message) => {
			const { command, args } = await writingHolder(code);
			const handle = spawnChild({ label: "holder", command, args });
			const exitedAt = exitTime(handle);
			const buffer = new ChildOutputBuffer(handle);
			let handedOut = 0;

			try {
				while (!buffer.failure && !buffer.ended) {
					buffer.pull();
					handedOut += buffer.take()?.length ?? 0;

					if (!buffer.failure && !buffer.ended) await buffer.nextChange();
				}

				const sinceExit = performance.now() - (await exitedAt);

				expect((buffer.failure as Error | undefined)?.message).toMatch(message);
				expect(buffer.failure instanceof ChildOutputHeldError).toBe(code === 0);
				expect(sinceExit).toBeLessThan(2500);
				expect(buffer.length).toBe(0);
				expect(handedOut).toBe(0);
			} finally {
				releaseChild(handle);
				buffer.dispose();
			}
		},
	);

	it("fails with the cap when a grandchild delivers more than 16 MiB after the exit", async () => {
		const args = isWindows
			? await windowsCommandFile([
					`@start /b "" "${process.execPath}" -e "setTimeout(function(){process.stdout.write(Buffer.alloc(17825792))},500)"`,
					"@exit 0",
				])
			: ["-c", "(sleep 0.5; head -c 17825792 /dev/zero) & exit 0"];
		const handle = spawnChild({ label: "holder", command: isWindows ? "cmd.exe" : "sh", args });
		const exitedAt = exitTime(handle);
		const buffer = new ChildOutputBuffer(handle);

		try {
			while (!buffer.failure && !buffer.ended) await buffer.nextChange();

			const sinceExit = performance.now() - (await exitedAt);

			expect(buffer.failure).toBeInstanceOf(ChildOutputHeldError);
			expect((buffer.failure as Error | undefined)?.message).toMatch(
				/delivered more than 16777216 bytes after the exit/,
			);
			expect(sinceExit).toBeLessThan(2000);
		} finally {
			releaseChild(handle);
			buffer.dispose();
		}
	});

	it("sets the abort reason as its failure without an unhandled rejection", async () => {
		const unhandled = vi.fn();

		process.on("unhandledRejection", unhandled);

		const handle = node("setInterval(() => undefined, 1000)");
		const controller = new AbortController();
		const buffer = new ChildOutputBuffer(handle, { signal: controller.signal });
		const reason = new Error("render aborted");

		try {
			controller.abort(reason);
			await delay(50);

			expect(buffer.failure).toBe(reason);
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
			await terminateChild(handle.child);
			releaseChild(handle);
			buffer.dispose();
		}
	});

	it("keeps a non-Error abort reason itself as its failure", async () => {
		const handle = node("setInterval(() => undefined, 1000)");
		const controller = new AbortController();
		const buffer = new ChildOutputBuffer(handle, { signal: controller.signal });

		try {
			controller.abort("cancelled");

			expect(buffer.failure).toBe("cancelled");
		} finally {
			await terminateChild(handle.child);
			releaseChild(handle);
			buffer.dispose();
		}
	});

	it("arms no deadline and sets no failure when the child exits after dispose", async () => {
		const handle = node("setTimeout(() => process.exit(0), 200)");
		const buffer = new ChildOutputBuffer(handle, { deadlineMs: 100 });

		try {
			buffer.dispose();

			let changed = false;

			void buffer.nextChange().then(() => {
				changed = true;
			});

			await handle.exited;
			await delay(300);

			expect(buffer.failure).toBeUndefined();
			expect(changed).toBe(false);
		} finally {
			releaseChild(handle);
		}
	});

	it("clears its deadline timer and removes its stdout listeners on dispose", async () => {
		const { command, args } = await briefHolder();
		const handle = spawnChild({ label: "holder", command, args });
		const stdout = handle.stdout;

		if (!stdout) throw new Error("no stdout");

		const readableBefore = stdout.listeners("readable");
		const endBefore = stdout.listeners("end");
		const buffer = new ChildOutputBuffer(handle, { deadlineMs: 200 });

		try {
			await handle.exited;
			await delay(0);
			buffer.dispose();
			await delay(400);

			expect(buffer.failure).toBeUndefined();
			expect(stdout.listeners("readable")).toEqual(readableBefore);
			expect(stdout.listeners("end")).toEqual(endBefore);
		} finally {
			releaseChild(handle);
		}
	});
});

describe("writeChildInput", () => {
	it("rejects with a clean early exit as an input that never ended", async () => {
		const handle = node(`process.stdin.once("data", () => process.exit(0))`);

		await expect(writeUntilRejected(handle)).rejects.toThrow("node exited before its input ended");
		releaseChild(handle);
	});

	it("rejects with the exit error of a failed exit", async () => {
		const handle = node(`process.stdin.once("data", () => process.stderr.write("bad", () => process.exit(3)))`);

		await expect(writeUntilRejected(handle)).rejects.toThrow(/exited 3: bad/);
		releaseChild(handle);
	});

	it("rejects with the abort reason while parked", async () => {
		const handle = node("setInterval(() => undefined, 1000)");
		const controller = new AbortController();
		const reason = new Error("render aborted");

		try {
			setTimeout(() => controller.abort(reason), 100);

			await expect(writeUntilRejected(handle, controller.signal)).rejects.toBe(reason);
		} finally {
			await terminateChild(handle.child);
			releaseChild(handle);
		}
	});

	it("rejects with the abort reason when the abort lands during the exit wait", async () => {
		const handle = node(
			`process.stdin.destroy(); process.stdout.write("ready\\n"); setInterval(() => undefined, 1000)`,
		);
		const controller = new AbortController();
		const reason = new Error("render aborted");

		try {
			await readyLine(handle);

			const writing = settleOrNull(writeChildInput(handle, Buffer.alloc(1024 * 1024), controller.signal));

			await delay(100);

			handle.stdin?.destroy();

			await delay(100);

			expect(handle.stdin?.destroyed).toBe(true);

			controller.abort(reason);

			expect(await writing).toBe(reason);
		} finally {
			await terminateChild(handle.child);
			releaseChild(handle);
		}
	});
});
