import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";

const TEARDOWN_KILL_GRACE_MS = 2000;
const STDERR_CAP_BYTES = 64 * 1024;
const STDERR_EXCERPT_CHARS = 1024;

export interface CliExitResult {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly error?: Error;
}

export interface CliChildHandle {
	readonly child: ChildProcessWithoutNullStreams;
	readonly exitPromise: Promise<CliExitResult>;
}

export interface SpawnCliOptions {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly onStderr: (chunk: Buffer) => void;
	readonly onStdinError: (error: Error & { code?: string }) => void;
}

export function spawnCliChild(options: SpawnCliOptions): CliChildHandle {
	const child = spawn(options.command, [...options.args], { stdio: ["pipe", "pipe", "pipe"] });

	child.stderr.on("data", options.onStderr);
	child.stdin.on("error", options.onStdinError);

	const exitPromise = new Promise<CliExitResult>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
		child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
		child.once("error", (error) => resolve({ code: null, signal: null, error }));
	});

	return { child, exitPromise };
}

export function appendStderr(current: string, chunk: Buffer): string {
	if (current.length >= STDERR_CAP_BYTES) return current;

	const remaining = STDERR_CAP_BYTES - current.length;
	const text = chunk.toString("utf8");

	return current + (text.length > remaining ? text.slice(0, remaining) : text);
}

export function exitError(label: string, exit: CliExitResult, stderr: string): Error | undefined {
	if (exit.code === 0) return undefined;

	if (exit.error) return new Error(`${label} failed to start: ${exit.error.message}`);

	const status = exit.code === null ? `exited with signal ${exit.signal ?? "unknown"}` : `exited ${exit.code}`;
	const detail = stderr ? `: ${stderr.slice(0, STDERR_EXCERPT_CHARS)}` : "";

	return new Error(`${label} ${status}${detail}`);
}

export function terminateChild(child: ChildProcess, graceMs = TEARDOWN_KILL_GRACE_MS): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

	return new Promise<void>((resolve) => {
		const settle = (): void => {
			clearTimeout(timer);
			child.off("exit", settle);
			child.off("close", settle);
			resolve();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			settle();
		}, graceMs);

		child.once("exit", settle);
		child.once("close", settle);
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

export async function settleWithin<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T | undefined> {
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

export function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
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
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
