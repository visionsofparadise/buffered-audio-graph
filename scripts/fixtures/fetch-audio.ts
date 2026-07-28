import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndVerify, fileExists, s3AssetUrl, sha256File } from "../utils/download";

interface FixtureAsset {
	filename: string;
	sha256: string;
	size: number;
}

interface FixturesManifest {
	version: number;
	bucket: string;
	region: string;
	assets: Array<FixtureAsset>;
}

function resolveRepoRoot(): string {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));

	return path.resolve(scriptDir, "..", "..");
}

function resolveAudioDir(): string {
	return path.resolve(resolveRepoRoot(), "..", "fixtures", "audio");
}

async function main(): Promise<void> {
	const manifestPath = path.join(resolveRepoRoot(), "fixtures.manifest.json");
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as FixturesManifest;

	const audioDir = resolveAudioDir();

	console.warn(`[fixtures] audio dir: ${audioDir}`);
	console.warn(`[fixtures] assets:    ${manifest.assets.length}`);

	for (const asset of manifest.assets) {
		const destination = path.join(audioDir, asset.filename);

		if (await fileExists(destination)) {
			const existing = await sha256File(destination);

			if (existing === asset.sha256) {
				console.warn(`[fixtures] cache hit  ${asset.filename}`);

				continue;
			}

			console.warn(
				`[fixtures] stale      ${asset.filename} (sha256 ${existing} != ${asset.sha256}) — re-downloading`,
			);
			await fs.rm(destination, { force: true });
		}

		const url = s3AssetUrl(manifest.bucket, manifest.region, asset.sha256);

		console.warn(`[fixtures] download   ${asset.filename} <- ${url}`);
		await downloadAndVerify(url, destination, asset.sha256);
	}

	console.warn(`[fixtures] done — ${manifest.assets.length} audio fixture(s) ready`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
