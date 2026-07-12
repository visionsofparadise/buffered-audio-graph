import { app } from "electron";
import { existsSync, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Returns the absolute path to the bundled binaries directory.
 *
 * Both dev and packaged builds resolve to a `binaries/` directory owned
 * by the desktop app:
 * - Dev: `apps/desktop/binaries/` (`app.getAppPath()` is `apps/desktop/`).
 * - Packaged: `{resourcesPath}/binaries/`, populated by the Forge
 *   `extraResource: ['./binaries']` entry in `forge.config.ts`.
 *
 * The directory is expected to be populated out-of-band (CI artifact,
 * developer copy/symlink from shared fixtures, etc.). If it's missing,
 * `listBundledBinaryFiles` returns an empty map and callers treat that
 * as "no bundled defaults".
 */
export function getBundledBinariesPath(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "binaries");
	}

	return path.resolve(app.getAppPath(), "binaries");
}

/**
 * Reads the bundled binaries directory and returns a map of filename to
 * absolute path. Returns an empty map if the directory is missing or
 * unreadable — callers should treat that as "no binaries bundled".
 *
 * Only regular files are included; subdirectories are skipped. The keys
 * are the filenames as they appear on disk (e.g. `ffmpeg.exe`,
 * `model_1.onnx`); callers are responsible for mapping schema-binary
 * keys to these filenames.
 */
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

/**
 * Reads `<bundledBinariesPath>/manifest.json` (written by the binary
 * pipeline's install step — see
 * `projects/code/engineering/desktop/design-binary-pipeline.md`) and
 * returns a map of schema-binary key to absolute on-disk path.
 *
 * Entries whose resolved path does not exist on disk are skipped.
 *
 * On any failure (missing manifest, malformed JSON, schema violation),
 * returns an empty map and logs a warning. Callers treat `{}` as "no
 * bundled defaults available" — consistent with `listBundledBinaryFiles`.
 *
 * Intentionally uncached: reading on every invocation lets a manifest
 * swap during dev take effect without restarting the app.
 */
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

/**
 * Thrown by `getVst3CliPath` when the running platform/arch has no bundled
 * vst-demon-cli build (only win32-x64, linux-x64, and darwin-arm64 ship).
 */
export class UnsupportedVst3CliPlatformError extends Error {
	public constructor(target: string) {
		super(`No bundled vst-demon-cli binary for platform target "${target}".`);

		this.name = "UnsupportedVst3CliPlatformError";
	}
}

/**
 * Resolves the bundled vst-demon-cli binary for the current platform/arch.
 *
 * The CLI is a `key: null` manifest asset (see
 * `projects/code/buffered-audio-graph/desktop/design-binary-pipeline.md`),
 * so it never appears in `manifest.json`'s schema-key map and is resolved by
 * its arch-suffixed filename in the bundled binaries directory instead.
 *
 * Returns the absolute path plus whether it exists on disk. Callers should
 * surface a "binary missing — run npm run binaries:install" message when
 * `exists` is `false` rather than letting a later `spawn` fail with ENOENT.
 *
 * Throws `UnsupportedVst3CliPlatformError` when no binary ships for the
 * running platform/arch.
 */
export function getVst3CliPath(): { path: string; exists: boolean } {
	const target = `${process.platform}-${process.arch}`;
	const filename = VST3_CLI_FILENAMES[target];

	if (filename === undefined) {
		throw new UnsupportedVst3CliPlatformError(target);
	}

	const cliPath = path.join(getBundledBinariesPath(), filename);

	return { path: cliPath, exists: existsSync(cliPath) };
}
