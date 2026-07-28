import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveBinary(name: string, providedPath?: string): Promise<string> {
	if (providedPath) {
		await access(providedPath, constants.X_OK);

		return providedPath;
	}

	const envVar = `${name.toUpperCase()}_PATH`;
	const envPath = process.env[envVar];

	if (envPath) {
		await access(envPath, constants.X_OK);

		return envPath;
	}

	try {
		const { stdout } = await execFileAsync(process.platform === "win32" ? "where" : "which", [name]);
		const resolved = stdout.trim().split("\n")[0]?.trim();

		if (resolved) return resolved;
	} catch (error) {
		void error;
	}

	throw new Error(`Binary "${name}" not found. Provide a path via the unit's binaryPath property or set the ${envVar} environment variable.`);
}
