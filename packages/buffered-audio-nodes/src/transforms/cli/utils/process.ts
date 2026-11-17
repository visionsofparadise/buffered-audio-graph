import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function waitForChildWritable(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<void> {
	const { stdin } = child;

	if (child.exitCode !== null || child.signalCode !== null || stdin.destroyed || stdin.writableEnded || signal.aborted)
		return Promise.resolve();

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
