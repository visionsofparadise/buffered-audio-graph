import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { toJSONSchema } from "zod";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { SUPPORTED_API_VERSIONS } from "../../../models/ApiVersion";
import { registerPackage, type NodeClass } from "../../../models/NodeRegistry";
import {
	ENSURE_PACKAGE_ACTION,
	type EnsurePackageInput,
	type EnsurePackageIpcParameters,
	type EnsurePackageIpcReturn,
	type LoadedNodeInfo,
} from "./Renderer";

type PackageExports = string | Array<PackageExports> | { [key: string]: PackageExports } | null | undefined;

interface InstalledPackageJson {
	readonly exports?: PackageExports | { ".": PackageExports };
	readonly main?: string;
	readonly module?: string;
	readonly name?: string;
	readonly version?: string;
}

interface PacoteModule {
	manifest: (spec: string, options?: Record<string, unknown>) => Promise<{ name?: string; version?: string }>;
	extract: (
		spec: string,
		dest: string,
		options?: Record<string, unknown>,
	) => Promise<{ from?: string; integrity?: string; resolved?: string }>;
}

function assertRegistryPackageSpec(packageSpec: string): void {
	const trimmed = packageSpec.trim();

	if (!trimmed) {
		throw new Error("Package spec is required");
	}

	if (/^(?:git\+|https?:|file:|npm:|github:)/i.test(trimmed)) {
		throw new Error(`Unsupported package spec "${packageSpec}". Only registry package specs are allowed.`);
	}

	if (/^[./\\]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
		throw new Error(`Unsupported package spec "${packageSpec}". Only registry package specs are allowed.`);
	}

	if (!trimmed.startsWith("@") && trimmed.includes("/")) {
		throw new Error(`Unsupported package spec "${packageSpec}". Only registry package specs are allowed.`);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);

		return true;
	} catch {
		return false;
	}
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

async function resolveLoadEntryPath(installDirectory: string): Promise<string> {
	const raw = await readFile(join(installDirectory, "package.json"), "utf-8");
	const packageJson = JSON.parse(raw) as InstalledPackageJson;
	const rootExports =
		packageJson.exports && typeof packageJson.exports === "object" && !Array.isArray(packageJson.exports) && "." in packageJson.exports
			? packageJson.exports["."]
			: packageJson.exports;
	const candidates = [
		...collectExportEntries(rootExports),
		...(packageJson.module ? [packageJson.module] : []),
		...(packageJson.main ? [packageJson.main] : []),
	];

	for (const candidate of candidates) {
		if (!candidate || candidate.startsWith("#")) {
			continue;
		}

		const resolvedPath = join(installDirectory, candidate);

		if (await pathExists(resolvedPath)) {
			return resolvedPath;
		}
	}

	throw new Error(`Unable to resolve a loadable entry from package exports in ${installDirectory}`);
}

function packageDirectory(packageName: string, packageVersion: string): string {
	return join(
		app.getPath("userData"),
		"packages",
		encodeURIComponent(packageName),
		packageVersion,
	);
}

async function loadPacote(): Promise<PacoteModule> {
	const pacoteModule = (await import("pacote")) as PacoteModule | { default?: PacoteModule };

	if ("manifest" in pacoteModule) {
		return pacoteModule;
	}

	if (!pacoteModule.default) {
		throw new Error("Failed to load pacote");
	}

	return pacoteModule.default;
}

function isNodeClass(value: unknown): value is NodeClass {
	return (
		typeof value === "function" && "nodeName" in value && typeof value.nodeName === "string" && "description" in value && typeof value.description === "string" && "schema" in value
	);
}

function getNodeCategory(value: NodeClass): "source" | "transform" | "target" {
	const prototype: unknown = value.prototype;

	if (typeof prototype === "object" && prototype !== null) {
		if ("createRenderJob" in prototype && typeof prototype.createRenderJob === "function") return "source";
		if ("to" in prototype && typeof prototype.to === "function") return "transform";
	}

	return "target";
}

export class EnsurePackageMainIpc extends AsyncMainIpc<EnsurePackageIpcParameters, EnsurePackageIpcReturn> {
	action = ENSURE_PACKAGE_ACTION;

	async handler(input: EnsurePackageInput, dependencies: IpcHandlerDependencies): Promise<EnsurePackageIpcReturn> {
		assertRegistryPackageSpec(input.packageSpec);

		const pacote = await loadPacote();
		const cache = join(app.getPath("userData"), "package-cache");
		const manifest = await pacote.manifest(input.packageSpec, { cache });
		const packageName = manifest.name;
		const packageVersion = manifest.version;

		if (!packageName || !packageVersion) {
			throw new Error(`Failed to resolve package identity for "${input.packageSpec}"`);
		}

		const installDirectory = packageDirectory(packageName, packageVersion);
		const packageJsonPath = join(installDirectory, "package.json");
		const isInstalled = await pathExists(packageJsonPath);

		if (!isInstalled) {
			await mkdir(join(app.getPath("userData"), "packages", encodeURIComponent(packageName)), { recursive: true });
			await pacote.extract(input.packageSpec, installDirectory, { cache });
		}

		const loadEntryPath = await resolveLoadEntryPath(installDirectory);
		const url = `${pathToFileURL(loadEntryPath).href}?t=${Date.now()}`;
		const exports = (await import(url)) as Record<string, unknown>;
		const nodes = new Map<string, NodeClass>();
		const result: Array<LoadedNodeInfo> = [];
		const apiVersions = new Set<number>();

		for (const value of Object.values(exports)) {
			if (isNodeClass(value)) {
				nodes.set(value.nodeName, value);
				apiVersions.add(value.apiVersion);

				result.push({
					nodeName: value.nodeName,
					description: value.description,
					schema: toJSONSchema(value.schema) as LoadedNodeInfo["schema"],
					category: getNodeCategory(value),
				});
			}
		}

		if (nodes.size === 0) {
			throw new Error(`Package "${packageName}" exports no node classes`);
		}

		if (apiVersions.size > 1) {
			throw new Error(`Package "${packageName}" has mixed API versions: ${[...apiVersions].join(", ")}`);
		}

		const [apiVersion] = apiVersions;

		if (apiVersion === undefined) {
			throw new Error(`Package "${packageName}" predates the apiVersion marker and cannot load`);
		}

		if (!SUPPORTED_API_VERSIONS.has(apiVersion)) {
			throw new Error(`Package "${packageName}" has unsupported API version ${apiVersion}`);
		}

		registerPackage(dependencies.nodeRegistry, packageName, packageVersion, nodes);

		return { packageName, packageVersion, apiVersion, nodes: result };
	}
}
