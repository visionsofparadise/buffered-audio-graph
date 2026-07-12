import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BufferedAudioNode, NodeRegistry } from "@buffered-audio/core";

type NodeConstructor = new (options?: Record<string, unknown>) => BufferedAudioNode;

type PackageExports = string | Array<PackageExports> | { [key: string]: PackageExports } | null | undefined;

interface PackageManifest {
	readonly exports?: PackageExports | { ".": PackageExports };
	readonly main?: string;
	readonly module?: string;
	readonly name?: string;
	readonly version?: string;
}

interface PacoteApi {
	extract: (spec: string, dest: string, options?: Record<string, unknown>) => Promise<{ from?: string; integrity?: string; resolved?: string }>;
}

function readManifest(packageDir: string): PackageManifest {
	return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as PackageManifest;
}

function collectExportEntries(exportsValue: PackageExports): Array<string> {
	if (!exportsValue) return [];
	if (typeof exportsValue === "string") return [exportsValue];
	if (Array.isArray(exportsValue)) return exportsValue.flatMap((value) => collectExportEntries(value));

	const preferredKeys = ["import", "default", "require", "node"];
	const orderedKeys = [
		...preferredKeys.filter((key) => key in exportsValue),
		...Object.keys(exportsValue).filter((key) => key !== "types" && !preferredKeys.includes(key)),
	];

	return orderedKeys.flatMap((key) => collectExportEntries(exportsValue[key]));
}

function resolveEntryPath(packageDir: string): string {
	const manifest = readManifest(packageDir);
	const rootExports =
		manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports) && "." in manifest.exports
			? manifest.exports["."]
			: manifest.exports;
	const candidates = [...collectExportEntries(rootExports), ...(manifest.module ? [manifest.module] : []), ...(manifest.main ? [manifest.main] : [])];

	for (const candidate of candidates) {
		if (!candidate || candidate.startsWith("#")) continue;

		const resolved = join(packageDir, candidate);

		if (existsSync(resolved)) return resolved;
	}

	throw new Error(`Unable to resolve a loadable entry from package exports in ${packageDir}`);
}

async function importPackageDir(packageDir: string): Promise<Record<string, unknown>> {
	const entry = resolveEntryPath(packageDir);

	return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}

function locateAmbientPackageDir(name: string): string | undefined {
	// A CLI is invoked from a project, so ambient resolution anchors at the working
	// directory rather than the CLI's own install location. `require.resolve(name)`
	// throws ERR_PACKAGE_PATH_NOT_EXPORTED for exports-restricted packages (no `require`
	// condition), so walk the resolver's candidate node_modules bases directly.
	const require = createRequire(join(process.cwd(), "noop.js"));
	const searchPaths = require.resolve.paths(name) ?? [];

	for (const base of searchPaths) {
		const candidate = join(base, name);

		if (existsSync(join(candidate, "package.json"))) return candidate;
	}

	return undefined;
}

function packagesCacheRoot(): string {
	return join(homedir(), ".buffered-audio", "packages");
}

async function loadPacote(): Promise<PacoteApi> {
	const pacoteModule = (await import("pacote")) as PacoteApi | { default?: PacoteApi };

	if ("extract" in pacoteModule) return pacoteModule;
	if (!pacoteModule.default) throw new Error("Failed to load pacote");

	return pacoteModule.default;
}

async function fetchPackage(name: string, version: string, cacheDir: string): Promise<void> {
	const pacote = await loadPacote();
	const cache = join(homedir(), ".buffered-audio", "cache");

	await mkdir(dirname(cacheDir), { recursive: true });
	await pacote.extract(`${name}@${version}`, cacheDir, { cache });
}

function indexExports(mod: Record<string, unknown>): Map<string, NodeConstructor> {
	const packageMap = new Map<string, NodeConstructor>();

	// Bag node lookups go by `nodeName` (what `pack()` writes), not by export binding
	// name. Index every export that has a string `nodeName`; ignore the rest (factory
	// functions, types, etc.).
	for (const value of Object.values(mod)) {
		if (typeof value !== "function") continue;

		const ctor = value as { nodeName?: unknown } & NodeConstructor;

		if (typeof ctor.nodeName !== "string") continue;

		packageMap.set(ctor.nodeName, ctor);
	}

	return packageMap;
}

async function resolvePackage(name: string, version: string, options: { install: boolean; overrides: Map<string, string> }): Promise<Record<string, unknown>> {
	const overridePath = options.overrides.get(name);

	if (overridePath !== undefined) {
		process.stderr.write(`warn: --resolve overrides pin ${name}@${version} with local path ${overridePath}\n`);

		return importPackageDir(overridePath);
	}

	const ambientDir = locateAmbientPackageDir(name);

	if (ambientDir !== undefined && readManifest(ambientDir).version === version) {
		return importPackageDir(ambientDir);
	}

	const cacheDir = join(packagesCacheRoot(), encodeURIComponent(name), version);

	if (existsSync(join(cacheDir, "package.json"))) {
		return importPackageDir(cacheDir);
	}

	if (!options.install) {
		throw new Error(
			`Cannot resolve ${name}@${version}: not present in the working project's node_modules or the package cache, and --no-install disables fetching. Re-run without --no-install, or install ${name}@${version} in this project.`,
		);
	}

	await fetchPackage(name, version, cacheDir);

	return importPackageDir(cacheDir);
}

export async function resolvePackages(packages: Record<string, string>, options: { install: boolean; overrides: Map<string, string> }): Promise<NodeRegistry> {
	const registry: NodeRegistry = new Map();

	for (const [name, version] of Object.entries(packages)) {
		const mod = await resolvePackage(name, version, options);

		registry.set(name, indexExports(mod));
	}

	return registry;
}
