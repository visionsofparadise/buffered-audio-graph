import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
} from "./manifest.ts";

export function resolveCacheDir(): string {
	return path.join(resolveRepoRoot(), ".binaries-cache");
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const handle = await fs.open(filePath, "r");

	try {
		const stream = handle.createReadStream();

		for await (const chunk of stream) {
			hash.update(chunk as Buffer);
		}
	} finally {
		await handle.close();
	}

	return hash.digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);

		return true;
	} catch {
		return false;
	}
}

async function downloadAndVerify(url: string, destination: string, expectedSha256: string): Promise<void> {
	const tempPath = `${destination}.tmp`;

	await fs.mkdir(path.dirname(destination), { recursive: true });

	const response = await fetch(url);

	if (!response.ok || response.body === null) {
		throw new Error(`Download failed for ${url}: HTTP ${response.status} ${response.statusText}`);
	}

	const hash = createHash("sha256");
	const writeStream = createWriteStream(tempPath);
	const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

	try {
		await pipeline(
			bodyStream,
			async function* (source: AsyncIterable<Buffer | Uint8Array>) {
				for await (const chunk of source) {
					const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);

					hash.update(buf);
					yield buf;
				}
			},
			writeStream,
		);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}

	const actualSha256 = hash.digest("hex");

	if (actualSha256 !== expectedSha256) {
		await fs.rm(tempPath, { force: true });
		throw new Error(`sha256 mismatch for ${url} — expected ${expectedSha256}, got ${actualSha256}`);
	}

	await fs.rename(tempPath, destination);
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
