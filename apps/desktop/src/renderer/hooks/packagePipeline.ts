import type { GraphDefinition } from "@buffered-audio/core";
import type { Snapshot } from "valtio/vanilla";
import { packageNameFromSpec, packageSpecFromNameAndVersion } from "../../shared/utilities/packageSpec";
import type { Main } from "../models/Main";
import type { ProxyStore } from "../models/ProxyStore/ProxyStore";
import type { AppState, ModulePackageState } from "../models/State/App";

export function comparePackageVersions(left: string, right: string): number {
	return left.localeCompare(right, undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

export function packageInstallDirectory(userDataPath: string, packageName: string, packageVersion: string): string {
	return `${userDataPath}/packages/${encodeURIComponent(packageName)}/${packageVersion}`;
}

export function mutatePackageAt(
	appStore: ProxyStore,
	app: Snapshot<AppState>,
	index: number,
	callback: (entry: ModulePackageState) => void,
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
	options?: { readonly isBuiltIn?: boolean },
): { index: number; entry: ModulePackageState } {
	const existingIndex = app.packages.findIndex((entry) => entry.requestedSpec === requestedSpec);

	if (existingIndex !== -1) {
		return {
			index: existingIndex,
			entry: app.packages[existingIndex] as ModulePackageState,
		};
	}

	const newEntry: ModulePackageState = {
		requestedSpec,
		name: packageNameFromSpec(requestedSpec),
		version: null,
		status: "pending",
		error: null,
		modules: [],
		isBuiltIn: options?.isBuiltIn ?? false,
	};

	appStore.mutate(app, (proxy) => {
		proxy.packages.push(newEntry);
	});

	return { index: app.packages.length, entry: newEntry };
}

export async function runPackagePipeline(
	entry: Snapshot<ModulePackageState>,
	index: number,
	app: Snapshot<AppState>,
	appStore: ProxyStore,
	main: Main,
): Promise<void> {
	mutatePackageAt(appStore, app, index, (target) => {
		target.status = "installing";
		target.error = null;
		target.modules = [];
		target.version = null;
	});

	const install = await main.installPackage({ packageSpec: entry.requestedSpec });

	mutatePackageAt(appStore, app, index, (target) => {
		target.name = install.packageName;
		target.version = install.packageVersion;
		target.status = "loading";
	});

	const modules = await main.loadPackageModules({
		loadEntryPath: install.loadEntryPath,
		packageName: install.packageName,
		packageVersion: install.packageVersion,
	});

	mutatePackageAt(appStore, app, index, (target) => {
		target.name = install.packageName;
		target.version = install.packageVersion;
		target.status = "ready";
		target.error = null;
		target.modules = [...modules];
	});
}

export async function ensureGraphPackagesInstalled(
	graphDefinition: GraphDefinition,
	app: Snapshot<AppState>,
	appStore: ProxyStore,
	main: Main,
): Promise<void> {
	const requestedSpecs = Array.from(
		new Set(
			graphDefinition.nodes.map((node) => {
				const packageVersion = typeof node.packageVersion === "string" ? node.packageVersion : "";

				return packageSpecFromNameAndVersion(node.packageName, packageVersion);
			}),
		),
	);

	for (const requestedSpec of requestedSpecs) {
		const targetName = packageNameFromSpec(requestedSpec);
		const targetVersion = requestedSpec.slice(targetName.length + 1);
		const readyEntry = app.packages.find(
			(entry) => entry.status === "ready" && entry.name === targetName && entry.version === targetVersion,
		);

		if (readyEntry) {
			continue;
		}

		const { index, entry } = ensurePackageState(app, appStore, requestedSpec);

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
