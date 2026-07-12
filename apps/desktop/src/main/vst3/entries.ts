import { buildEntryKey, type Vst3ScanEntry } from "../../shared/ipc/Vst3/Vst3ScanEntry";
import type { WalkModule } from "./walk";

export const derivePendingEntry = (module: WalkModule): Vst3ScanEntry => ({
	entryKey: buildEntryKey(module.modulePath),
	name: module.name,
	modulePath: module.modulePath,
	rootPath: module.rootPath,
	vendorFolder: module.vendorFolder,
	status: "pending",
});

export const deriveReadyEntries = (module: WalkModule, classNames: ReadonlyArray<string>): ReadonlyArray<Vst3ScanEntry> => {
	if (classNames.length <= 1) {
		return [
			{
				entryKey: buildEntryKey(module.modulePath),
				name: module.name,
				modulePath: module.modulePath,
				rootPath: module.rootPath,
				vendorFolder: module.vendorFolder,
				status: "ready",
			},
		];
	}

	return classNames.map((className) => ({
		entryKey: buildEntryKey(module.modulePath, className),
		name: className,
		modulePath: module.modulePath,
		rootPath: module.rootPath,
		vendorFolder: module.vendorFolder,
		className,
		status: "ready",
	}));
};

export const deriveErrorEntry = (module: WalkModule, error: string): Vst3ScanEntry => ({
	entryKey: buildEntryKey(module.modulePath),
	name: module.name,
	modulePath: module.modulePath,
	rootPath: module.rootPath,
	vendorFolder: module.vendorFolder,
	status: "error",
	error,
});
