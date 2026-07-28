import { app } from "electron";
import { existsSync, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";

export function getBundledBinariesPath(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "binaries");
	}

	return path.resolve(app.getAppPath(), "binaries");
}

export async function listBundledBinaryFiles(): Promise<Record<string, string>> {
	const directory = getBundledBinariesPath();

	let entries: Array<Dirent>;

	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch {
		return {};
	}

	const map: Record<string, string> = {};

	for (const entry of entries) {
		if (!entry.isFile()) continue;

		map[entry.name] = path.join(directory, entry.name);
	}

	return map;
}

const bundledBinariesManifestSchema = z.object({
	target: z.string(),
	binaries: z.record(z.string(), z.string()),
});

export async function readBundledBinaryDefaults(): Promise<Record<string, string>> {
	const directory = getBundledBinariesPath();
	const manifestPath = path.join(directory, "manifest.json");

	let raw: string;

	try {
		raw = await fs.readFile(manifestPath, "utf8");
	} catch (error) {
		console.warn(`[bundledBinaries] Failed to read manifest at ${manifestPath}:`, error);

		return {};
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.warn(`[bundledBinaries] Malformed JSON in manifest at ${manifestPath}:`, error);

		return {};
	}

	const result = bundledBinariesManifestSchema.safeParse(parsed);

	if (!result.success) {
		console.warn(`[bundledBinaries] Manifest at ${manifestPath} failed schema validation:`, result.error);

		return {};
	}

	const resolved: Record<string, string> = {};

	for (const [key, filename] of Object.entries(result.data.binaries)) {
		const absolutePath = path.join(directory, filename);

		try {
			await fs.stat(absolutePath);
		} catch {
			continue;
		}

		resolved[key] = absolutePath;
	}

	return resolved;
}

const VST3_CLI_FILENAMES: Record<string, string> = {
	"win32-x64": "vst-demon-cli-win32-x64.exe",
	"linux-x64": "vst-demon-cli-linux-x64",
	"darwin-arm64": "vst-demon-cli-darwin-arm64",
};

export class UnsupportedVst3CliPlatformError extends Error {
	public constructor(target: string) {
		super(`No bundled vst-demon-cli binary for platform target "${target}".`);

		this.name = "UnsupportedVst3CliPlatformError";
	}
}

export function getVst3CliPath(): { path: string; exists: boolean } {
	const target = `${process.platform}-${process.arch}`;
	const filename = VST3_CLI_FILENAMES[target];

	if (filename === undefined) {
		throw new UnsupportedVst3CliPlatformError(target);
	}

	const cliPath = path.join(getBundledBinariesPath(), filename);

	return { path: cliPath, exists: existsSync(cliPath) };
}
