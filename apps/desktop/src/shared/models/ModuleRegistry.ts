import type { BufferedAudioNode } from "@buffered-audio/core";
import type { z } from "zod";

export interface ModuleClass {
	readonly moduleName: string;
	readonly moduleDescription: string;
	readonly schema: z.ZodType;

	new (properties?: Record<string, unknown>): BufferedAudioNode;
}

export type ModuleRegistry = ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, ModuleClass>>>;

export type ModuleRegistryMap = Map<string, Map<string, Map<string, ModuleClass>>>;

export function createModuleRegistry(): ModuleRegistryMap {
	return new Map();
}

export function registerPackage(
	registry: ModuleRegistryMap,
	packageName: string,
	packageVersion: string,
	modules: Map<string, ModuleClass>,
): void {
	const packageVersions = registry.get(packageName) ?? new Map<string, Map<string, ModuleClass>>();

	packageVersions.set(packageVersion, modules);
	registry.set(packageName, packageVersions);
}

export function unregisterPackage(registry: ModuleRegistryMap, packageName: string, packageVersion: string): void {
	const packageVersions = registry.get(packageName);

	if (!packageVersions) {
		return;
	}

	packageVersions.delete(packageVersion);

	if (packageVersions.size === 0) {
		registry.delete(packageName);
	}
}

export function resolvePackageModules(
	registry: ModuleRegistryMap,
	packageName: string,
	packageVersion: string,
): Map<string, ModuleClass> | undefined {
	return registry.get(packageName)?.get(packageVersion);
}
