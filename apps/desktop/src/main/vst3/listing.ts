import { spawn } from "node:child_process";
import { z } from "zod";

export const CRASH_EXIT_CODES: ReadonlyArray<number> = [3221225477, -1073741819];

export const isCrashExit = (code: number | null): boolean => code !== null && CRASH_EXIT_CODES.includes(code);

const classNamesSchema = z.array(z.string());

export const parseClassNames = (stdout: string): ReadonlyArray<string> => classNamesSchema.parse(JSON.parse(stdout.trim()));

export const tailLines = (text: string, count = 5): string => text.trim().split(/\r?\n/).slice(-count).join("\n").trim();

export type ListResult = { readonly ok: true; readonly classNames: ReadonlyArray<string> } | { readonly ok: false; readonly error: string };

const runOnce = async (cliPath: string, modulePath: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
	new Promise((resolve, reject) => {
		const child = spawn(cliPath, ["--plugin", modulePath, "--list"]);

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", (error: Error) => {
			reject(new Error(`Failed to spawn CLI for ${modulePath}: ${error.message}`));
		});

		child.on("close", (code) => {
			resolve({ code, stdout, stderr });
		});
	});

export const listModule = async (cliPath: string, modulePath: string): Promise<ListResult> => {
	let attempt = await runOnce(cliPath, modulePath);

	if (isCrashExit(attempt.code)) {
		attempt = await runOnce(cliPath, modulePath);
	}

	if (attempt.code !== 0) {
		const detail = tailLines(attempt.stderr) || `CLI exited with code ${String(attempt.code)}`;

		return { ok: false, error: detail };
	}

	try {
		return { ok: true, classNames: parseClassNames(attempt.stdout) };
	} catch (error) {
		return { ok: false, error: `Failed to parse --list output for ${modulePath}: ${String(error)}` };
	}
};
