import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../shared/models/Logger";

export interface WalkModule {
	readonly modulePath: string;
	readonly rootPath: string;
	readonly vendorFolder: string;
	readonly name: string;
}

export interface DirentLike {
	readonly name: string;
	isDirectory(): boolean;
}

export const isModuleDirent = (dirent: DirentLike): boolean => dirent.name.toLowerCase().endsWith(".vst3");

export const moduleNameFromPath = (modulePath: string): string => path.basename(modulePath).replace(/\.vst3$/i, "");

export type ReadDirectory = (directory: string) => ReadonlyArray<DirentLike>;

export const walkRoot = (root: string, readDirectory: ReadDirectory, onWarn?: (directory: string, error: unknown) => void): ReadonlyArray<WalkModule> => {
	const modules: Array<WalkModule> = [];

	const recurse = (directory: string, vendorFolder: string): void => {
		let entries: ReadonlyArray<DirentLike>;

		try {
			entries = readDirectory(directory);
		} catch (error) {
			onWarn?.(directory, error);

			return;
		}

		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);

			if (isModuleDirent(entry)) {
				const resolvedVendor = vendorFolder === "" ? entry.name : vendorFolder;

				modules.push({ modulePath: entryPath, rootPath: root, vendorFolder: resolvedVendor, name: moduleNameFromPath(entryPath) });

				continue;
			}

			if (entry.isDirectory()) {
				recurse(entryPath, vendorFolder === "" ? entry.name : vendorFolder);
			}
		}
	};

	recurse(root, "");

	return modules;
};

const readDirectoryFromFs: ReadDirectory = (directory) => fs.readdirSync(directory, { withFileTypes: true });

export const walkVst3Roots = (roots: ReadonlyArray<string>, logger: Logger): ReadonlyArray<WalkModule> => {
	const modules: Array<WalkModule> = [];
	const seen = new Set<string>();

	for (const root of roots) {
		if (!fs.existsSync(root)) continue;

		const rootModules = walkRoot(root, readDirectoryFromFs, (directory, error) => {
			logger.warn("Skipping unreadable VST3 directory", { namespace: "vst3", directory, error: String(error) });
		});

		for (const module of rootModules) {
			if (seen.has(module.modulePath)) continue;

			seen.add(module.modulePath);
			modules.push(module);
		}
	}

	return modules;
};
