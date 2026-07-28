import type { BufferedAudioNode } from "@buffered-audio/core";
import type { z } from "zod";

export interface NodeClass {
	readonly nodeName: string;
	readonly description: string;
	readonly apiVersion: number;
	readonly schema: z.ZodType;

	new (properties?: Record<string, unknown>): BufferedAudioNode;
}

export type NodeRegistry = ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, NodeClass>>>;

export type NodeRegistryMap = Map<string, Map<string, Map<string, NodeClass>>>;

export function createNodeRegistry(): NodeRegistryMap {
	return new Map();
}

export function registerPackage(
	registry: NodeRegistryMap,
	packageName: string,
	packageVersion: string,
	nodes: Map<string, NodeClass>,
): void {
	const packageVersions = registry.get(packageName) ?? new Map<string, Map<string, NodeClass>>();

	packageVersions.set(packageVersion, nodes);
	registry.set(packageName, packageVersions);
}

export function unregisterPackage(registry: NodeRegistryMap, packageName: string, packageVersion: string): void {
	const packageVersions = registry.get(packageName);

	if (!packageVersions) {
		return;
	}

	packageVersions.delete(packageVersion);

	if (packageVersions.size === 0) {
		registry.delete(packageName);
	}
}

export function resolvePackageNodes(
	registry: NodeRegistryMap,
	packageName: string,
	packageVersion: string,
): Map<string, NodeClass> | undefined {
	return registry.get(packageName)?.get(packageVersion);
}
