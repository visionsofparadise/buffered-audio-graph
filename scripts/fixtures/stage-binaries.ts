import { promises as fs } from "node:fs";
import path from "node:path";
import {
	assetPath,
	filterAssetsForTarget,
	formatTarget,
	type ManifestAsset,
	parseTargetArgs,
	readManifest,
	resolveRepoRoot,
	type Target,
} from "../binaries/manifest";

const KEY_TO_FIXTURE_FILENAME: Record<string, string> = {
	"onnx-addon": "onnx_addon.node",
	"vkfft-addon": "vkfft_addon.node",
	"fftw-addon": "fftw_addon.node",
	"faust-addon": "faust_addon.node",
	"dtln-model_1": "model_1.onnx",
	"dtln-model_2": "model_2.onnx",
	Kim_Vocal_2: "Kim_Vocal_2.onnx",
	htdemucs: "htdemucs.onnx",
	dfn3: "dfn3.onnx",
	"silero-vad": "silero-vad.onnx",
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
	sourcePath: string;
	sourceFilename: string;
	destFilename: string;
}

function resolveDefaultOutDir(): string {
	return path.resolve(resolveRepoRoot(), "fixtures", "binaries");
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
			console.warn(`[fixtures:stage] skip     ${asset.filename} (not needed by tests)`);

			continue;
		}

		entries.push({ sourcePath: assetPath(asset), sourceFilename: asset.filename, destFilename });
	}

	console.warn(`[fixtures:stage] target:  ${formatTarget(target)}`);
	console.warn(`[fixtures:stage] out dir: ${outDir}`);
	console.warn(`[fixtures:stage] assets:  ${entries.length}`);

	for (const entry of entries) {
		const arrow = entry.sourceFilename === entry.destFilename ? "==" : "->";

		console.warn(`[fixtures:stage] ${arrow} ${entry.sourceFilename} ${arrow} ${entry.destFilename}`);
	}

	if (dryRun) {
		const names = entries.map((entry) => entry.destFilename).sort((left, right) => left.localeCompare(right));

		console.warn(`[fixtures:stage] dry-run — ${names.length} destination file(s):`);
		console.warn(names.join("\n"));

		return;
	}

	await fs.mkdir(outDir, { recursive: true });

	for (const entry of entries) {
		const destination = path.join(outDir, entry.destFilename);

		await fs.copyFile(entry.sourcePath, destination);

		if (target.platform !== "win32" && (entry.destFilename === "ffmpeg" || entry.destFilename === "ffprobe")) {
			await fs.chmod(destination, 0o755);
		}

		console.warn(`[fixtures:stage] copy   ${entry.destFilename}`);
	}

	console.warn(`[fixtures:stage] done — ${entries.length} asset(s) into ${outDir} for ${formatTarget(target)}`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
