import { promises as fs } from "node:fs";
import path from "node:path";
import {
	assetPath,
	filterAssetsForTarget,
	formatTarget,
	type ManifestAsset,
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
	destFilename: string;
}

export async function stageFixtureBinaries(target: Target): Promise<void> {
	const outDir = path.resolve(resolveRepoRoot(), "fixtures", "binaries");
	const manifest = await readManifest();
	const entries: Array<CopyEntry> = [];

	for (const asset of filterAssetsForTarget(manifest.assets, target)) {
		const destFilename = resolveFixtureFilename(asset, target);

		if (destFilename !== null) entries.push({ sourcePath: assetPath(asset), destFilename });
	}

	await fs.mkdir(outDir, { recursive: true });

	for (const entry of entries) {
		const destination = path.join(outDir, entry.destFilename);

		await fs.copyFile(entry.sourcePath, destination);

		if (target.platform !== "win32" && (entry.destFilename === "ffmpeg" || entry.destFilename === "ffprobe")) {
			await fs.chmod(destination, 0o755);
		}
	}

	console.warn(`[assets:pull] staged ${entries.length} test binaries into ${outDir} for ${formatTarget(target)}`);
}
