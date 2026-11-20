import readline from "node:readline";
import { childExitError, releaseChild, spawnChild, waitForChildClose } from "@buffered-audio/core";
import { parseVst3EditorLine, type Vst3EditorEvent } from "../../shared/ipc/Vst3/Vst3EditorEvent";
import type { Logger } from "../../shared/Models/Logger";

const LABEL = "vst-demon-cli";
const STDERR_TAIL_LINE_LIMIT = 20;
const STDERR_TAIL_BYTE_LIMIT = 4096;

export interface LaunchVst3EditorOptions {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly launchId: string;
	readonly logger: Logger;
	readonly emit: (event: Vst3EditorEvent) => void;
}

const trimStderrTail = (stderr: string): string => {
	const nonEmpty = stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const tail = nonEmpty.slice(-STDERR_TAIL_LINE_LIMIT).join("\n");

	return tail.length > STDERR_TAIL_BYTE_LIMIT ? tail.slice(-STDERR_TAIL_BYTE_LIMIT) : tail;
};

export function launchVst3Editor(options: LaunchVst3EditorOptions): void {
	const { command, args, launchId, logger, emit } = options;
	const handle = spawnChild({ label: LABEL, command, args, detached: true, windowsHide: false, stdin: "ignore" });

	if (handle.stdout) {
		const lines = readline.createInterface({ input: handle.stdout });

		lines.on("line", (line: string) => {
			const event = parseVst3EditorLine(line);

			if (event === undefined) {
				logger.warn("Unparseable VST3 editor stdout line", { namespace: "vst3", launchId, line });

				return;
			}

			emit(event);
		});
	}

	const reportExit = async (): Promise<void> => {
		const exit = await handle.exited;

		await waitForChildClose(handle);

		const stderr = handle.stderrTail();
		const failure = childExitError(LABEL, exit, stderr);

		emit({
			event: "exited",
			code: exit.code,
			stderrTail: trimStderrTail(stderr),
			...(failure === undefined ? {} : { error: failure.message }),
		});
		releaseChild(handle);
	};

	reportExit().catch((error: unknown) => {
		logger.error("VST3 editor exit handling failed", error instanceof Error ? error : new Error(String(error)), {
			namespace: "vst3",
			launchId,
		});
	});

	handle.child.unref();
}
