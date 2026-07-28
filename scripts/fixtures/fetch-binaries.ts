import { promises as fs } from "node:fs";
import path from "node:path";

import { fetchForTarget } from "../binaries/fetch.ts";
import {
	filterAssetsForTarget,
	formatTarget,
	type ManifestAsset,
	parseTargetArgs,
	readManifest,
	resolveRepoRoot,
	type Target,
} from "../binaries/manifest.ts";

const KEY_TO_FIXTURE_FILENAME: Record<string, string> = {
	"onnx-addon": "onnx_addon.node",
	"vkfft-addon": "vkfft_addon.node",
	"fftw-addon": "fftw_addon.node",
	"dtln-model_1": "model_1.onnx",
	"dtln-model_2": "model_2.onnx",
	Kim_Vocal_2: "Kim_Vocal_2.onnx",
	htdemucs: "htdemucs.onnx",
	dfn3: "dfn3.onnx",
};

const RUNTIME_LIB_RENAME: Record<string, string> = {
	"onnxruntime-win32-x64.dll": "onnxruntime.dll",
	"onnxruntime-linux-x64.so.1.22.0": "libonnxruntime.so.1",
};

function exeSuffix(target: Target): string {
	return target.platform === "win32" ? ".exe" : "";
}

function resolveFixtureFilename(asset: ManifestAsset, target: Target): string | null {
	if (asset.key === "ffmpeg" || asset.key === "ffprobe") {
		return `${asset.key}${exeSuffix(target)}`;
	}

	if (asset.key !== null) {
		return KEY_TO_FIXTURE_FILENAME[asset.key] ?? null;
	}

	return RUNTIME_LIB_RENAME[asset.filename] ?? asset.filename;
}

interface CopyEntry {
	sourceFilename: string;
	destFilename: string;
}

function resolveDefaultOutDir(): string {
	return path.resolve(resolveRepoRoot(), "..", "fixtures", "binaries");
}

function parseArgs(argv: ReadonlyArray<string>): {
	target: Target;
	dryRun: boolean;
	outDir: string;
} {
	const passthrough: Array<string> = [];
	let dryRun = false;
	let outDirOverride: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];

		if (token === undefined) continue;

		if (token === "--dry-run") {
			dryRun = true;
		} else if (token === "--out") {
			const next = argv[index + 1];

			if (next === undefined) throw new Error("--out requires a value");

			outDirOverride = next;
			index += 1;
		} else if (token.startsWith("--out=")) {
			outDirOverride = token.slice("--out=".length);
		} else {
			passthrough.push(token);
		}
	}

	const target = parseTargetArgs(passthrough);
	const outDir = outDirOverride !== undefined ? path.resolve(outDirOverride) : resolveDefaultOutDir();

	return { target, dryRun, outDir };
}

async function main(): Promise<void> {
	const { target, dryRun, outDir } = parseArgs(process.argv.slice(2));

	const manifest = await readManifest();
	const included = filterAssetsForTarget(manifest.assets, target);

	const entries: Array<CopyEntry> = [];

	for (const asset of included) {
		const destFilename = resolveFixtureFilename(asset, target);

		if (destFilename === null) {
			console.warn(`[fixtures:binaries] skip     ${asset.filename} (not needed by tests)`);
			continue;
		}

		entries.push({ sourceFilename: asset.filename, destFilename });
	}

	console.warn(`[fixtures:binaries] target:  ${formatTarget(target)}`);
	console.warn(`[fixtures:binaries] out dir: ${outDir}`);
	console.warn(`[fixtures:binaries] assets:  ${entries.length}`);

	for (const entry of entries) {
		const arrow = entry.sourceFilename === entry.destFilename ? "==" : "->";

		console.warn(`[fixtures:binaries] ${arrow} ${entry.sourceFilename} ${arrow} ${entry.destFilename}`);
	}

	if (dryRun) {
		const names = entries.map((entry) => entry.destFilename).sort((left, right) => left.localeCompare(right));

		console.warn(`[fixtures:binaries] dry-run — ${names.length} destination file(s):`);
		console.warn(names.join("\n"));

		return;
	}

	const { cachePaths } = await fetchForTarget(target);

	await fs.mkdir(outDir, { recursive: true });

	for (const entry of entries) {
		const cachePath = cachePaths.get(entry.sourceFilename);

		if (cachePath === undefined) {
			throw new Error(
				`Internal error: cache path missing for ${entry.sourceFilename} after fetch`,
			);
		}

		const destination = path.join(outDir, entry.destFilename);

		await fs.copyFile(cachePath, destination);

		if (target.platform !== "win32" && (entry.destFilename === "ffmpeg" || entry.destFilename === "ffprobe")) {
			await fs.chmod(destination, 0o755);
		}

		console.warn(`[fixtures:binaries] copy   ${entry.destFilename}`);
	}

	console.warn(
		`[fixtures:binaries] done — ${entries.length} asset(s) into ${outDir} for ${formatTarget(target)}`,
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
