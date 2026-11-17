import type { ChildProcess } from "node:child_process";

export function waitForDrain(proc: ChildProcess, stdin: NodeJS.WritableStream, label: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			stdin.removeListener("drain", onDrain);
			proc.removeListener("error", onError);
			proc.removeListener("close", onClose);
		};
		const onDrain = (): void => {
			cleanup();
			resolve();
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onClose = (code: number | null): void => {
			cleanup();
			reject(new Error(`${label} exited with code ${code} while writing stdin`));
		};

		stdin.once("drain", onDrain);
		proc.once("error", onError);
		proc.once("close", onClose);
	});
}
