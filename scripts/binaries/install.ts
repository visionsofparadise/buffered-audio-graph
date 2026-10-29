import { execFileSync } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import {
	assetPath,
	filterAssetsForTarget,
	formatTarget,
	type Manifest,
	type ManifestAsset,
	parseTargetArgs,
	readManifest,
	resolveRepoRoot,
	type Target,
} from "./manifest";

function resolveDesktopBinariesDir(): string {
	return path.join(resolveRepoRoot(), "apps", "desktop", "binaries");
}

async function clearTopLevelRegularFiles(directory: string): Promise<number> {
	let entries: Array<Dirent>;

	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error: unknown) {
		if (error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
			await fs.mkdir(directory, { recursive: true });

			return 0;
		}

		throw error;
	}

	let removed = 0;

	for (const entry of entries) {
		if (!entry.isFile()) continue;

		if (entry.name.startsWith(".")) continue;

		await fs.rm(path.join(directory, entry.name), { force: true });
		removed += 1;
	}

	return removed;
}

/**
 * @returns the system tar. On Windows that is its own bsdtar, which reads .zip as well as .tar.gz; a Git or MSYS tar earlier on the PATH reads tar only.
 */
function systemTar(): string {
	return process.platform === "win32"
		? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
		: "tar";
}

async function extractAsset(source: string, destinationDir: string, entry: string): Promise<void> {
	const folder = entry.split("/")[0];

	if (folder === undefined || folder === entry) throw new Error(`Archive entry "${entry}" must sit inside a folder`);

	await fs.rm(path.join(destinationDir, folder), { recursive: true, force: true });
	execFileSync(systemTar(), ["-xf", source, "-C", destinationDir], { stdio: "inherit" });
	await fs.stat(path.join(destinationDir, entry));
}

async function installAsset(source: string, destination: string, asset: ManifestAsset, target: Target): Promise<void> {
	if (asset.entry !== undefined) {
		await extractAsset(source, path.dirname(destination), asset.entry);

		return;
	}

	await fs.copyFile(source, destination);

	if (target.platform !== "win32" && (asset.key === "ffmpeg" || asset.key === "ffprobe")) {
		await fs.chmod(destination, 0o755);
	}
}

function buildSchemaKeyMap(included: ReadonlyArray<ManifestAsset>): Record<string, string> {
	const map: Record<string, string> = {};

	for (const asset of included) {
		if (asset.key === null) continue;

		map[asset.key] = asset.entry ?? asset.filename;
	}

	return map;
}

export async function installForTarget(target: Target): Promise<{
	manifest: Manifest;
	included: Array<ManifestAsset>;
	destinationDir: string;
	schemaKeyMap: Record<string, string>;
}> {
	const manifest = await readManifest();
	const included = filterAssetsForTarget(manifest.assets, target);
	const destinationDir = resolveDesktopBinariesDir();

	const removed = await clearTopLevelRegularFiles(destinationDir);

	console.warn(`[install] cleared ${removed} file(s) from ${destinationDir}`);

	for (const asset of included) {
		const destination = path.join(destinationDir, asset.filename);

		await installAsset(assetPath(asset), destination, asset, target);
		console.warn(`[install] ${asset.entry === undefined ? "copy   " : "extract"} ${asset.filename}`);
	}

	const schemaKeyMap = buildSchemaKeyMap(included);

	const installManifest = {
		target: formatTarget(target),
		binaries: schemaKeyMap,
	};

	const manifestPath = path.join(destinationDir, "manifest.json");

	await fs.writeFile(manifestPath, `${JSON.stringify(installManifest, null, 2)}\n`, "utf8");
	console.warn(`[install] wrote ${manifestPath}`);

	return { manifest, included, destinationDir, schemaKeyMap };
}

async function main(): Promise<void> {
	const target = parseTargetArgs(process.argv.slice(2));

	const { included, schemaKeyMap } = await installForTarget(target);

	console.warn(
		`[install] done — ${included.length} asset(s) installed for ${formatTarget(target)} (${Object.keys(schemaKeyMap).length} schema keys)`,
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
