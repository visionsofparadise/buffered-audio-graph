/**
 * Shared helpers for reading `binaries.manifest.json` and filtering its
 * assets for a target `<platform>-<arch>`. Used by both `fetch.ts` and
 * `install.ts`.
 *
 * Keeps the manifest shape and target-filter logic in one place so the
 * two consumers cannot drift.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Platform = "all" | "win32" | "linux" | "darwin";
export type Arch = "all" | "x64" | "arm64";

export interface ManifestAsset {
	// Schema binary key in @buffered-audio/nodes Zod schemas, or null
	// for assets that are installed to disk but not exposed as a schema
	// binary (e.g. ONNX Runtime shared libs loaded dynamically by the
	// addon; HTDemucs external-data sidecar loaded automatically by ORT).
	key: string | null;
	platform: Platform;
	arch: Arch;
	filename: string;
	sha256: string;
	size: number;
	source: string;
}

export interface Manifest {
	version: number;
	bucket: string;
	region: string;
	assets: Array<ManifestAsset>;
}

export interface Target {
	platform: "win32" | "linux" | "darwin";
	arch: "x64" | "arm64";
}

const VALID_PLATFORMS: ReadonlyArray<Target["platform"]> = ["win32", "linux", "darwin"];
const VALID_ARCHES: ReadonlyArray<Target["arch"]> = ["x64", "arm64"];

/**
 * Resolves the absolute path to `binaries.manifest.json` at the repo root.
 * This script lives at `<repo>/scripts/binaries/manifest.ts`, so the
 * repo root is two levels up from the script's directory.
 */
export function resolveManifestPath(): string {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const repoRoot = path.resolve(scriptDir, "..", "..");

	return path.join(repoRoot, "binaries.manifest.json");
}

export function resolveRepoRoot(): string {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));

	return path.resolve(scriptDir, "..", "..");
}

export async function readManifest(): Promise<Manifest> {
	const manifestPath = resolveManifestPath();
	const raw = await readFile(manifestPath, "utf8");

	return JSON.parse(raw) as Manifest;
}

/**
 * Parses `<platform>-<arch>` into a Target. Throws on malformed input or
 * unsupported platform/arch.
 */
export function parseTarget(value: string): Target {
	const parts = value.split("-");

	if (parts.length !== 2) {
		throw new Error(
			`Invalid --target value "${value}" — expected "<platform>-<arch>" (e.g. "win32-x64")`,
		);
	}

	const [platform, arch] = parts;

	if (platform === undefined || !VALID_PLATFORMS.includes(platform as Target["platform"])) {
		throw new Error(
			`Invalid --target platform "${platform ?? ""}" — expected one of ${VALID_PLATFORMS.join(", ")}`,
		);
	}

	if (arch === undefined || !VALID_ARCHES.includes(arch as Target["arch"])) {
		throw new Error(
			`Invalid --target arch "${arch ?? ""}" — expected one of ${VALID_ARCHES.join(", ")}`,
		);
	}

	return {
		platform: platform as Target["platform"],
		arch: arch as Target["arch"],
	};
}

/**
 * Returns the host target resolved from Node's process.platform / arch,
 * or throws if the host is not one of the three supported combinations.
 */
export function resolveHostTarget(): Target {
	const platform = process.platform;
	const arch = process.arch;

	if (!VALID_PLATFORMS.includes(platform as Target["platform"])) {
		throw new Error(
			`Unsupported host platform "${platform}" — supported platforms: ${VALID_PLATFORMS.join(", ")}`,
		);
	}

	if (!VALID_ARCHES.includes(arch as Target["arch"])) {
		throw new Error(
			`Unsupported host arch "${arch}" — supported arches: ${VALID_ARCHES.join(", ")}`,
		);
	}

	return {
		platform: platform as Target["platform"],
		arch: arch as Target["arch"],
	};
}

export function formatTarget(target: Target): string {
	return `${target.platform}-${target.arch}`;
}

/**
 * Parses `--target <platform>-<arch>` / `--target=<platform>-<arch>` from
 * a list of CLI argument tokens. Defaults to the host target when no
 * --target flag is present.
 *
 * Throws on unknown flags so typos surface immediately rather than
 * silently defaulting.
 */
export function parseTargetArgs(argv: ReadonlyArray<string>): Target {
	let explicit: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];

		if (token === undefined) continue;

		if (token === "--target") {
			const next = argv[index + 1];

			if (next === undefined) throw new Error("--target requires a value");

			explicit = next;
			index += 1;
		} else if (token.startsWith("--target=")) {
			explicit = token.slice("--target=".length);
		} else {
			throw new Error(`Unknown argument: ${token}`);
		}
	}

	return explicit === undefined ? resolveHostTarget() : parseTarget(explicit);
}

/**
 * Returns the subset of manifest assets that should be installed for the
 * given target. An asset is included when its platform/arch is either
 * "all" or matches the target exactly.
 */
export function filterAssetsForTarget(
	assets: ReadonlyArray<ManifestAsset>,
	target: Target,
): Array<ManifestAsset> {
	return assets.filter(
		(asset) =>
			(asset.platform === "all" || asset.platform === target.platform) &&
			(asset.arch === "all" || asset.arch === target.arch),
	);
}

/**
 * Constructs the public S3 URL for a content-addressed asset. Matches the
 * virtual-hosted-style URL pattern documented in the service design.
 */
export function assetUrl(manifest: Manifest, asset: ManifestAsset): string {
	return `https://${manifest.bucket}.s3.${manifest.region}.amazonaws.com/sha256/${asset.sha256}`;
}
