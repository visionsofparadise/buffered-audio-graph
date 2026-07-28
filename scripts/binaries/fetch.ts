import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { downloadAndVerify, fileExists, sha256File } from "../utils/download";
import {
	assetUrl,
	filterAssetsForTarget,
	formatTarget,
	type Manifest,
	type ManifestAsset,
	parseTargetArgs,
	readManifest,
	resolveRepoRoot,
	type Target,
} from "./manifest";

export function resolveCacheDir(): string {
	return path.join(resolveRepoRoot(), ".binaries-cache");
}

export async function ensureCached(manifest: Manifest, asset: ManifestAsset, cacheDir: string): Promise<string> {
	const assetDir = path.join(cacheDir, asset.sha256);
	const cachePath = path.join(assetDir, asset.filename);

	if (await fileExists(cachePath)) {
		const existingSha256 = await sha256File(cachePath);

		if (existingSha256 === asset.sha256) {
			console.warn(`[fetch] cache hit  ${asset.filename}`);

			return cachePath;
		}

		console.warn(
			`[fetch] cache corrupt ${asset.filename} (sha256 ${existingSha256} != ${asset.sha256}) — re-downloading`,
		);

		await fs.rm(cachePath, { force: true });
	}

	const url = assetUrl(manifest, asset);

	console.warn(`[fetch] download   ${asset.filename} <- ${url}`);

	await downloadAndVerify(url, cachePath, asset.sha256);

	return cachePath;
}

export async function fetchForTarget(target: Target): Promise<{
	manifest: Manifest;
	included: Array<ManifestAsset>;
	cacheDir: string;
	cachePaths: Map<string, string>;
}> {
	const manifest = await readManifest();
	const included = filterAssetsForTarget(manifest.assets, target);
	const cacheDir = resolveCacheDir();

	console.warn(`[fetch] target: ${formatTarget(target)}`);
	console.warn(`[fetch] cache:  ${cacheDir}`);
	console.warn(`[fetch] assets: ${included.length}`);

	const cachePaths = new Map<string, string>();

	for (const asset of included) {
		const cachePath = await ensureCached(manifest, asset, cacheDir);

		cachePaths.set(asset.filename, cachePath);
	}

	return { manifest, included, cacheDir, cachePaths };
}

async function main(): Promise<void> {
	const target = parseTargetArgs(process.argv.slice(2));

	const { included } = await fetchForTarget(target);

	console.warn(`[fetch] done — ${included.length} assets cached for ${formatTarget(target)}`);
}

const entryArgv = process.argv[1];

if (entryArgv !== undefined && import.meta.url === pathToFileURL(entryArgv).href) {
	main().catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
