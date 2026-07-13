import type { GraphDefinition } from "@buffered-audio/core";
import type { Snapshot } from "valtio/vanilla";
import { packageNameFromSpec, packageSpecFromNameAndVersion } from "../../shared/utilities/packageSpec";
import type { Main } from "../models/Main";
import type { ProxyStore } from "../models/ProxyStore/ProxyStore";
import type { AppState, NodePackageState } from "../models/State/App";

export function comparePackageVersions(left: string, right: string): number {
	return left.localeCompare(right, undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

export function packageInstallDirectory(userDataPath: string, packageName: string, version: string): string {
	return `${userDataPath}/packages/${encodeURIComponent(packageName)}/${version}`;
}

export function mutatePackageAt(
	appStore: ProxyStore,
	app: Snapshot<AppState>,
	index: number,
	callback: (entry: NodePackageState) => void,
): void {
	appStore.mutate(app, (proxy) => {
		const entry = proxy.packages[index];

		if (entry) {
			callback(entry);
		}
	});
}

export function ensurePackageState(
	app: Snapshot<AppState>,
	appStore: ProxyStore,
	requestedSpec: string,
	options?: { readonly isBuiltIn?: boolean; readonly origin?: NodePackageState["origin"] },
): { index: number; entry: NodePackageState } {
	const existingIndex = app.packages.findIndex((entry) => entry.requestedSpec === requestedSpec);

	if (existingIndex !== -1) {
		return {
			index: existingIndex,
			entry: app.packages[existingIndex] as NodePackageState,
		};
	}

	const newEntry: NodePackageState = {
		requestedSpec,
		name: packageNameFromSpec(requestedSpec),
		version: null,
		apiVersion: null,
		status: "pending",
		error: null,
		nodes: [],
		isBuiltIn: options?.isBuiltIn ?? false,
		origin: options?.origin ?? "catalog",
	};

	let newIndex = -1;

	appStore.mutate(app, (proxy) => {
		newIndex = proxy.packages.push(newEntry) - 1;
	});

	return { index: newIndex, entry: newEntry };
}

export async function runPackagePipeline(
	entry: Snapshot<NodePackageState>,
	index: number,
	app: Snapshot<AppState>,
	appStore: ProxyStore,
	main: Main,
): Promise<void> {
	mutatePackageAt(appStore, app, index, (target) => {
		target.status = "installing";
		target.error = null;
		target.nodes = [];
		target.version = null;
		target.apiVersion = null;
	});

	const result = await main.ensurePackage({ packageSpec: entry.requestedSpec });

	mutatePackageAt(appStore, app, index, (target) => {
		target.name = result.packageName;
		target.version = result.packageVersion;
		target.apiVersion = result.apiVersion;
		target.status = "ready";
		target.error = null;
		target.nodes = [...result.nodes];
	});
}

export async function ensureGraphPackagesInstalled(
	graphDefinition: GraphDefinition,
	app: Snapshot<AppState>,
	appStore: ProxyStore,
	main: Main,
): Promise<void> {
	const seen = new Set<string>();
	const pairs: Array<{ packageName: string; packageVersion: string }> = [];

	for (const node of graphDefinition.nodes) {
		const key = packageSpecFromNameAndVersion(node.packageName, node.packageVersion);

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		pairs.push({ packageName: node.packageName, packageVersion: node.packageVersion });
	}

	for (const { packageName, packageVersion } of pairs) {
		const satisfied = app.packages.some(
			(entry) => entry.status === "ready" && entry.name === packageName && entry.version === packageVersion,
		);

		if (satisfied) {
			continue;
		}

		const requestedSpec = packageSpecFromNameAndVersion(packageName, packageVersion);
		const { index, entry } = ensurePackageState(app, appStore, requestedSpec, { origin: "dependency" });

		if (entry.status === "ready") {
			continue;
		}

		try {
			await runPackagePipeline(entry, index, app, appStore, main);
		} catch (error) {
			mutatePackageAt(appStore, app, index, (target) => {
				target.status = "error";
				target.error = error instanceof Error ? error.message : String(error);
			});

			throw error;
		}
	}
}
