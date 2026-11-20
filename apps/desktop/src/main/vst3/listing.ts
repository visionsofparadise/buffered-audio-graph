import { runChild, type RunChildResult } from "@buffered-audio/core";
import { z } from "zod";

export const CRASH_EXIT_CODES: ReadonlyArray<number> = [3221225477, -1073741819];

const CRASH_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGSEGV", "SIGABRT", "SIGBUS", "SIGILL", "SIGFPE"];

export const isCrashExit = (code: number | null, signal: NodeJS.Signals | null = null): boolean =>
	(code !== null && CRASH_EXIT_CODES.includes(code)) || (signal !== null && CRASH_SIGNALS.includes(signal));

const classNamesSchema = z.array(z.string());

export const parseClassNames = (stdout: string): ReadonlyArray<string> =>
	classNamesSchema.parse(JSON.parse(stdout.trim()));

export const tailLines = (text: string, count = 5): string =>
	text.trim().split(/\r?\n/).slice(-count).join("\n").trim();

export type ListResult =
	| { readonly ok: true; readonly classNames: ReadonlyArray<string> }
	| { readonly ok: false; readonly error: string; readonly cacheable: boolean };

export interface ListModuleOptions {
	readonly prefixArgs?: ReadonlyArray<string>;
	readonly timeoutMs?: number;
}

const LIST_TIMEOUT_MS = 300_000;
const LIST_STDOUT_LIMIT_BYTES = 1024 * 1024;

const runOnce = (cliPath: string, modulePath: string, options: ListModuleOptions): Promise<RunChildResult> =>
	runChild({
		label: "vst-demon-cli",
		command: cliPath,
		args: [...(options.prefixArgs ?? []), "--plugin", modulePath, "--list"],
		timeoutMs: options.timeoutMs ?? LIST_TIMEOUT_MS,
		stdoutLimitBytes: LIST_STDOUT_LIMIT_BYTES,
	});

export const listModule = async (
	cliPath: string,
	modulePath: string,
	options: ListModuleOptions = {},
): Promise<ListResult> => {
	let attempt: RunChildResult;

	try {
		attempt = await runOnce(cliPath, modulePath, options);

		if (isCrashExit(attempt.exit.code, attempt.exit.signal)) {
			attempt = await runOnce(cliPath, modulePath, options);
		}
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), cacheable: false };
	}

	if (attempt.exit.spawnError) {
		return { ok: false, error: (attempt.failure ?? attempt.exit.spawnError).message, cacheable: false };
	}

	if (attempt.failure) {
		return {
			ok: false,
			error: tailLines(attempt.stderr) || attempt.failure.message,
			cacheable: attempt.exit.signal === null || isCrashExit(null, attempt.exit.signal),
		};
	}

	try {
		return { ok: true, classNames: parseClassNames(attempt.stdout.toString()) };
	} catch (error) {
		return {
			ok: false,
			error: `Failed to parse --list output for ${modulePath}: ${String(error)}`,
			cacheable: true,
		};
	}
};
