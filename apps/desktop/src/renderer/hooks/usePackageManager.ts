import { useCallback } from "react";
import type { AppContext } from "../models/Context";
import {
	ensurePackageState,
	mutatePackageAt,
	packageInstallDirectory,
	runPackagePipeline,
} from "./packagePipeline";

export interface PackageManager {
	addPackage: (packageSpec: string) => Promise<void>;
	removePackage: (requestedSpec: string) => Promise<void>;
	updatePackage: (requestedSpec: string) => Promise<void>;
	clearDependencies: () => Promise<void>;
}

export function usePackageManager(context: AppContext): PackageManager {
	const { app, main, userDataPath } = context;

	const addPackage = useCallback(
		async (packageSpec: string): Promise<void> => {
			const requestedSpec = packageSpec.trim();

			if (!requestedSpec) {
				throw new Error("Package spec is required");
			}

			const { index, entry } = ensurePackageState(app, requestedSpec);

			if (entry.status === "ready") {
				return;
			}

			try {
				await runPackagePipeline(entry, index, app, main);
			} catch (error) {
				mutatePackageAt(app, index, (target) => {
					target.status = "error";
					target.error = error instanceof Error ? error.message : String(error);
				});
			}
		},
		[app, main],
	);

	const removePackage = useCallback(
		async (requestedSpec: string): Promise<void> => {
			const index = app.packages.findIndex((entry) => entry.requestedSpec === requestedSpec);

			if (index === -1) {
				return;
			}

			const entry = app.packages[index];

			if (!entry || entry.isBuiltIn || !entry.version) {
				return;
			}

			await main.unloadPackageNodes({
				packageName: entry.name,
				packageVersion: entry.version,
			});

			await main.deleteFile(packageInstallDirectory(userDataPath, entry.name, entry.version));

			app.mutate((mutable) => {
				mutable.packages.splice(index, 1);
			});
		},
		[app, main, userDataPath],
	);

	const updatePackage = useCallback(
		async (requestedSpec: string): Promise<void> => {
			const index = app.packages.findIndex((entry) => entry.requestedSpec === requestedSpec);

			if (index === -1) {
				return;
			}

			const entry = app.packages[index];

			if (!entry) {
				return;
			}

			if (entry.version) {
				await main.unloadPackageNodes({
					packageName: entry.name,
					packageVersion: entry.version,
				});

				await main.deleteFile(packageInstallDirectory(userDataPath, entry.name, entry.version));
			}

			mutatePackageAt(app, index, (target) => {
				target.status = "pending";
				target.error = null;
				target.nodes = [];
				target.version = null;
			});

			try {
				await runPackagePipeline(
					{
						...entry,
						status: "pending",
						error: null,
						nodes: [],
						version: null,
					},
					index,
					app,
					main,
				);
			} catch (error) {
				mutatePackageAt(app, index, (target) => {
					target.status = "error";
					target.error = error instanceof Error ? error.message : String(error);
				});
			}
		},
		[app, main, userDataPath],
	);

	const clearDependencies = useCallback(async (): Promise<void> => {
		const dependencies = app.packages.filter((entry) => entry.origin === "dependency");

		if (dependencies.length === 0) {
			return;
		}

		await Promise.all(
			dependencies.map(async (entry) => {
				if (!entry.version) {
					return;
				}

				await main.unloadPackageNodes({
					packageName: entry.name,
					packageVersion: entry.version,
				});

				await main.deleteFile(packageInstallDirectory(userDataPath, entry.name, entry.version));
			}),
		);

		app.mutate((mutable) => {
			for (let index = mutable.packages.length - 1; index >= 0; index -= 1) {
				if (mutable.packages[index]?.origin === "dependency") {
					mutable.packages.splice(index, 1);
				}
			}
		});
	}, [app, main, userDataPath]);

	return { addPackage, removePackage, updatePackage, clearDependencies };
}
