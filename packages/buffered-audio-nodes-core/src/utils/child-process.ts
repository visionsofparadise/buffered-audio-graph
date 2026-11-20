import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const STDERR_TAIL_BYTES = 64 * 1024;
const STDERR_EXCERPT_CHARS = 1024;
const CLOSE_WAIT_MS = 2000;
const OUTPUT_DEADLINE_MS = 2000;
const TERMINATE_GRACE_MS = 2000;
const POST_KILL_WAIT_MS = 1000;
const DEFAULT_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;

export interface ChildExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly spawnError?: Error;
}

export interface SpawnChildOptions {
	readonly label: string;
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly stdin?: "pipe" | "ignore";
	readonly stdout?: "pipe" | "ignore";
	readonly detached?: boolean;
	readonly windowsHide?: boolean;
}

export interface ChildHandle {
	readonly label: string;
	readonly child: ChildProcess;
	readonly stdin?: Writable;
	readonly stdout?: Readable;
	readonly exited: Promise<ChildExit>;
	readonly closed: Promise<ChildExit>;
	readonly stderrTail: () => string;
	readonly stdinError: () => Error | undefined;
	readonly outputDeadline: () => number | undefined;
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export function spawnChild(options: SpawnChildOptions): ChildHandle {
	const { label } = options;
	let child: ChildProcess;

	try {
		child = spawn(options.command, [...options.args], {
			stdio: [options.stdin ?? "pipe", options.stdout ?? "pipe", "pipe"],
			detached: options.detached ?? false,
			windowsHide: options.windowsHide ?? true,
		});
	} catch (error) {
		throw new Error(`${label} failed to start: ${toError(error).message}`, { cause: error });
	}

	const stderrTail = child.stderr ? captureStderrTail(child.stderr) : (): string => "";
	let stdinError: Error | undefined;
	let started = false;
	let deadline: number | undefined;
	let settleExited: (exit: ChildExit) => void = () => undefined;
	let settleClosed: (exit: ChildExit) => void = () => undefined;
	const exited = new Promise<ChildExit>((resolve) => {
		settleExited = (exit) => {
			deadline ??= performance.now() + OUTPUT_DEADLINE_MS;
			resolve(exit);
		};
	});
	const closed = new Promise<ChildExit>((resolve) => {
		settleClosed = resolve;
	});

	child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE" || error.code === "EOF") return;

		stdinError ??= new Error(`${label} stdin error: ${error.message}`);
	});
	child.once("spawn", () => {
		started = true;
	});
	child.on("error", (spawnError) => {
		if (started) return;

		const exit: ChildExit = { code: null, signal: null, spawnError };

		settleExited(exit);
		settleClosed(exit);
	});
	child.once("exit", (code, signal) => {
		settleExited({ code, signal });
	});
	child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
		settleClosed({ code, signal });
	});

	return {
		label,
		child,
		stdin: child.stdin ?? undefined,
		stdout: child.stdout ?? undefined,
		exited,
		closed,
		stderrTail,
		stdinError: () => stdinError,
		outputDeadline: () => deadline,
	};
}

export function appendTail(tail: Buffer, chunk: Buffer, limitBytes: number): Buffer {
	if (chunk.length >= limitBytes) return Buffer.from(chunk.subarray(chunk.length - limitBytes));

	const combined = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);

	return combined.length <= limitBytes ? combined : combined.subarray(combined.length - limitBytes);
}

export function decodeTail(tail: Buffer, truncated: boolean): string {
	let start = 0;

	if (truncated) {
		while (start < 3 && start < tail.length && ((tail[start] ?? 0) & 0b11000000) === 0b10000000) start++;
	}

	return tail.toString("utf8", start);
}

export function captureStderrTail(stream: NodeJS.ReadableStream, limitBytes = STDERR_TAIL_BYTES): () => string {
	let tail: Buffer = Buffer.alloc(0);
	let truncated = false;

	stream.on("data", (chunk: Buffer | string) => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;

		if (tail.length + bytes.length > limitBytes) truncated = true;

		tail = appendTail(tail, bytes, limitBytes);
	});

	return () => decodeTail(tail, truncated);
}

function stderrExcerpt(stderr: string): string {
	const excerpt = stderr.slice(-STDERR_EXCERPT_CHARS);
	const first = excerpt.charCodeAt(0);

	return first >= 0xdc00 && first <= 0xdfff ? excerpt.slice(1) : excerpt;
}

export function childExitError(label: string, exit: ChildExit, stderr: string): Error | undefined {
	if (exit.spawnError)
		return new Error(`${label} failed to start: ${exit.spawnError.message}`, { cause: exit.spawnError });

	if (exit.code === 0) return undefined;

	const status = exit.code === null ? `exited with signal ${exit.signal ?? "unknown"}` : `exited ${exit.code}`;
	const detail = stderr ? `: ${stderrExcerpt(stderr)}` : "";

	return new Error(`${label} ${status}${detail}`);
}

export function discardChildOutput(handle: ChildHandle): void {
	handle.stdout?.removeAllListeners("readable");
	handle.stdout?.resume();
}

export function releaseChild(handle: ChildHandle): void {
	handle.stdin?.destroy();
	handle.stdout?.destroy();
	handle.child.stderr?.destroy();
}

export async function waitForChildClose(handle: ChildHandle, signal?: AbortSignal, ms = CLOSE_WAIT_MS): Promise<void> {
	discardChildOutput(handle);

	await settleWithin(handle.closed, ms, signal);
}

export interface ChildFailureOptions {
	readonly signal?: AbortSignal;
	readonly exitWithinMs?: number;
	readonly discardOutput?: boolean;
}

export async function childFailure(handle: ChildHandle, options?: ChildFailureOptions): Promise<Error | undefined> {
	const signal = options?.signal;

	if (options?.discardOutput) discardChildOutput(handle);

	const exit =
		options?.exitWithinMs === undefined
			? await unlessAborted(handle.exited, signal)
			: await settleWithin(handle.exited, options.exitWithinMs, signal);

	if (!exit) return undefined;

	if (exit.code === 0 && !exit.spawnError) return undefined;

	await waitForChildClose(handle, signal);

	return childExitError(handle.label, exit, handle.stderrTail());
}

export async function writeChildInput(handle: ChildHandle, chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
	const stdin = handle.stdin;

	if (!stdin) throw new Error(`${handle.label} has no stdin`);

	const kept = handle.stdinError();

	if (kept) throw kept;

	if (stdin.write(chunk)) return;

	await waitForChildWritable(handle.child, stdin, signal ?? new AbortController().signal);

	signal?.throwIfAborted();

	if (isChildGone(handle.child, stdin)) {
		const failure = await childFailure(handle, { signal });

		signal?.throwIfAborted();

		throw failure ?? handle.stdinError() ?? new Error(`${handle.label} exited before its input ended`);
	}

	const error = handle.stdinError();

	if (error) throw error;
}

export class ChildOutputHeldError extends Error {
	readonly label: string;

	constructor(label: string, detail: string) {
		super(`${label} exited, but its stdout ${detail}; a process it started may still hold it`);
		this.name = "ChildOutputHeldError";
		this.label = label;
	}
}

function heldError(handle: ChildHandle, exit: ChildExit, deadlineMs: number): Error {
	return (
		childExitError(handle.label, exit, handle.stderrTail()) ??
		new ChildOutputHeldError(handle.label, `stayed open for ${deadlineMs} ms`)
	);
}

export function boundAfterExit<T>(handle: ChildHandle, wait: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		wait.then(
			(value) => {
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				settled = true;
				clearTimeout(timer);
				// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- an abort keeps the signal's reason as it is
				reject(error);
			},
		);

		void handle.exited.then((exit) => {
			if (settled) return;

			const expire = (): void => {
				if (settled) return;

				settled = true;
				reject(heldError(handle, exit, OUTPUT_DEADLINE_MS));
			};
			const remaining = (handle.outputDeadline() ?? performance.now() + OUTPUT_DEADLINE_MS) - performance.now();

			if (remaining <= 0) {
				expire();

				return;
			}

			timer = setTimeout(expire, remaining);
			timer.unref();
		});
	});
}

export interface RunChildOptions extends Omit<SpawnChildOptions, "stdin" | "stdout"> {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly stdoutLimitBytes?: number;
}

export interface RunChildResult {
	readonly exit: ChildExit;
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly failure?: Error;
}

function spawnFailureResult(label: string, error: unknown): RunChildResult {
	const raw = error instanceof Error && error.cause !== undefined ? error.cause : error;
	const exit: ChildExit = { code: null, signal: null, spawnError: toError(raw) };

	return { exit, stdout: Buffer.alloc(0), stderr: "", failure: childExitError(label, exit, "") };
}

export async function runChild(options: RunChildOptions): Promise<RunChildResult> {
	const { signal, timeoutMs, stdoutLimitBytes = DEFAULT_STDOUT_LIMIT_BYTES, ...spawnOptions } = options;
	const { label } = spawnOptions;

	signal?.throwIfAborted();

	let handle: ChildHandle;

	try {
		handle = spawnChild({ ...spawnOptions, stdin: "ignore", stdout: "pipe" });
	} catch (error) {
		return spawnFailureResult(label, error);
	}

	const stdout = handle.stdout;
	const chunks: Array<Buffer> = [];
	let size = 0;
	let stop: (reason: unknown) => void = () => undefined;
	const stopped = new Promise<never>((_resolve, reject) => {
		stop = (reason) => {
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- an abort keeps the signal's reason as it is
			reject(reason);
		};
	});
	const onAbort = (): void => {
		stop(signal?.reason);
	};
	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					stop(new Error(`${label} timed out after ${timeoutMs} ms`));
				}, timeoutMs);

	stopped.catch(() => undefined);
	signal?.addEventListener("abort", onAbort, { once: true });

	const stdoutEnded = new Promise<void>((resolve) => {
		stdout?.once("end", resolve);
		stdout?.once("close", resolve);

		if (!stdout) resolve();
	});

	stdout?.on("data", (chunk: Buffer) => {
		size += chunk.length;

		if (size > stdoutLimitBytes) {
			stop(new Error(`${label} wrote more than ${stdoutLimitBytes} bytes to stdout`));

			return;
		}

		chunks.push(chunk);
	});

	try {
		const held = await Promise.race([
			boundAfterExit(handle, stdoutEnded).then(
				() => undefined,
				(error: unknown) => toError(error),
			),
			stopped,
		]);

		if (held instanceof ChildOutputHeldError) throw held;

		const exit = await Promise.race([handle.exited, stopped]);

		if (!held) await Promise.race([waitForChildClose(handle), stopped]);

		const stderr = handle.stderrTail();

		return { exit, stdout: Buffer.concat(chunks), stderr, failure: held ?? childExitError(label, exit, stderr) };
	} catch (error) {
		if (!(error instanceof ChildOutputHeldError)) await terminateChild(handle.child);

		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		releaseChild(handle);
	}
}

export interface ChildOutputBufferOptions {
	readonly signal?: AbortSignal;
	readonly limitBytes?: number;
	readonly deadlineMs?: number;
}

export class ChildOutputBuffer {
	private readonly stdout: Readable;
	private readonly label: string;
	private readonly limitBytes: number;
	private readonly deadlineMs: number;
	private readonly exitError: (exit: ChildExit) => Error | undefined;
	private readonly signal?: AbortSignal;
	private released: Array<Buffer> = [];
	private releasedBytes = 0;
	private held: Array<Buffer> = [];
	private heldBytes = 0;
	private exited = false;
	private stdoutEnded = false;
	private failed = false;
	private failureReason: unknown;
	private disposed = false;
	private timer?: ReturnType<typeof setTimeout>;
	private change?: Promise<void>;
	private resolveChange?: () => void;

	constructor(handle: ChildHandle, options?: ChildOutputBufferOptions) {
		if (!handle.stdout) throw new Error(`${handle.label} has no stdout to buffer`);

		this.stdout = handle.stdout;
		this.label = handle.label;
		this.limitBytes = options?.limitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES;
		this.deadlineMs = options?.deadlineMs ?? OUTPUT_DEADLINE_MS;
		this.exitError = (exit) => childExitError(handle.label, exit, handle.stderrTail());
		this.signal = options?.signal;
		this.stdout.on("readable", this.onReadable);
		this.stdout.once("end", this.onEnd);
		void handle.exited.then(this.onExit);

		if (this.signal?.aborted) this.fail(this.signal.reason);
		else this.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	get failure(): unknown {
		return this.failureReason;
	}

	get ended(): boolean {
		return this.stdoutEnded;
	}

	throwIfFailed(): void {
		if (this.failed) throw this.failureReason;
	}

	get length(): number {
		return this.releasedBytes;
	}

	nextChange(): Promise<void> {
		this.change ??= new Promise<void>((resolve) => {
			this.resolveChange = resolve;
		});

		return this.change;
	}

	notify(): void {
		const resolve = this.resolveChange;

		this.change = undefined;
		this.resolveChange = undefined;
		resolve?.();
	}

	pull(): void {
		if (this.failed) return;

		for (;;) {
			const chunk = this.stdout.read() as Buffer | null;

			if (!chunk) return;

			if (!this.exited) {
				this.released.push(chunk);
				this.releasedBytes += chunk.length;

				continue;
			}

			this.held.push(chunk);
			this.heldBytes += chunk.length;

			if (this.heldBytes > this.limitBytes) {
				this.fail(
					new ChildOutputHeldError(this.label, `delivered more than ${this.limitBytes} bytes after the exit`),
				);

				return;
			}
		}
	}

	take(maxBytes = Infinity): Buffer | undefined {
		if (this.failed || this.releasedBytes === 0) return undefined;

		const parts: Array<Buffer> = [];
		let size = 0;

		while (this.released.length > 0 && size < maxBytes) {
			const chunk = this.released[0];

			if (!chunk) break;

			const room = maxBytes - size;

			if (chunk.length <= room) {
				parts.push(chunk);
				size += chunk.length;
				this.released.shift();
			} else {
				parts.push(chunk.subarray(0, room));
				size += room;
				this.released[0] = chunk.subarray(room);
			}
		}

		this.releasedBytes -= size;

		return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
	}

	unshift(bytes: Buffer): void {
		if (this.failed || bytes.length === 0) return;

		this.released.unshift(bytes);
		this.releasedBytes += bytes.length;
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.stdout.off("readable", this.onReadable);
		this.stdout.off("end", this.onEnd);
		this.signal?.removeEventListener("abort", this.onAbort);
	}

	private readonly onReadable = (): void => {
		if (this.disposed) return;

		if (this.exited) this.pull();

		this.notify();
	};

	private readonly onEnd = (): void => {
		if (this.disposed) return;

		this.stdoutEnded = true;
		clearTimeout(this.timer);

		if (!this.failed) {
			this.released.push(...this.held);
			this.releasedBytes += this.heldBytes;
			this.held = [];
			this.heldBytes = 0;
		}

		this.notify();
	};

	private readonly onExit = (exit: ChildExit): void => {
		if (this.disposed) return;

		this.exited = true;
		this.pull();

		if (!this.stdoutEnded && !this.failed) {
			this.timer = setTimeout(() => {
				this.onDeadline(exit);
			}, this.deadlineMs);
			this.timer.unref();
		}

		this.notify();
	};

	private onDeadline(exit: ChildExit): void {
		if (this.disposed || this.stdoutEnded) return;

		this.fail(this.exitError(exit) ?? new ChildOutputHeldError(this.label, `stayed open for ${this.deadlineMs} ms`));
	}

	private readonly onAbort = (): void => {
		if (this.disposed) return;

		this.fail(this.signal?.reason);
	};

	private fail(reason: unknown): void {
		if (this.failed) return;

		this.failed = true;
		this.failureReason = reason;
		this.released = [];
		this.releasedBytes = 0;
		this.held = [];
		this.heldBytes = 0;
		clearTimeout(this.timer);
		this.notify();
	}
}

export interface TerminateChildOptions {
	readonly graceMs?: number;
	readonly firstSignal?: "SIGTERM" | "SIGKILL";
}

export function terminateChild(child: ChildProcess, options?: TerminateChildOptions): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

	const graceMs = options?.graceMs ?? TERMINATE_GRACE_MS;

	return new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const settle = (): void => {
			settled = true;
			clearTimeout(timer);
			child.off("exit", settle);
			child.off("close", settle);
			resolve();
		};
		const kill = (): void => {
			child.kill("SIGKILL");

			if (!settled) timer = setTimeout(settle, POST_KILL_WAIT_MS);
		};

		child.once("exit", settle);
		child.once("close", settle);

		if (options?.firstSignal === "SIGKILL") {
			kill();

			return;
		}

		timer = setTimeout(kill, graceMs);
		child.kill("SIGTERM");
	});
}

export type ChildStdin = NodeJS.WritableStream & { readonly destroyed?: boolean; readonly writableEnded?: boolean };

export function isChildGone(child: ChildProcess, stdin: ChildStdin): boolean {
	return (
		child.exitCode !== null || child.signalCode !== null || stdin.destroyed === true || stdin.writableEnded === true
	);
}

export function waitForChildWritable(child: ChildProcess, stdin: ChildStdin, signal: AbortSignal): Promise<void> {
	if (isChildGone(child, stdin) || signal.aborted) return Promise.resolve();

	return new Promise<void>((resolve) => {
		const settle = (): void => {
			stdin.off("drain", settle);
			stdin.off("close", settle);
			stdin.off("error", settle);
			child.off("exit", settle);
			child.off("error", settle);
			signal.removeEventListener("abort", settle);
			resolve();
		};

		stdin.once("drain", settle);
		stdin.once("close", settle);
		stdin.once("error", settle);
		child.once("exit", settle);
		child.once("error", settle);
		signal.addEventListener("abort", settle, { once: true });
	});
}

export async function settledOrAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;

	await unlessAborted(promise, signal);

	signal.throwIfAborted();

	return promise;
}

export async function settleWithin<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});

	try {
		return await unlessAborted(Promise.race([promise, timeout]), signal);
	} finally {
		clearTimeout(timer);
	}
}

export function unlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
	if (!signal) return promise;

	if (signal.aborted) return Promise.resolve(undefined);

	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = (): void => {
			resolve(undefined);
		};

		signal.addEventListener("abort", onAbort, { once: true });

		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(toError(error));
			},
		);
	});
}
