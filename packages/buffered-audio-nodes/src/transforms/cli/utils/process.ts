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
			signal.removeEventListener("abort", settle);
			resolve();
		};

		stdin.once("drain", settle);
		stdin.once("close", settle);
		stdin.once("error", settle);
		child.once("exit", settle);
		signal.addEventListener("abort", settle, { once: true });
	});
}
