import { basename } from "../../../../../../utils/path";
import type { Vst3ScanEntry } from "../../../../../../../shared/ipc/Vst3/Vst3ScanEntry";
import type { LeafParameter } from "../../utils/buildParameters";

export interface Stage {
	readonly pluginPath: string;
	readonly pluginName: string;
	readonly presetPath: string;
}

export interface VendorGroup {
	vendorFolder: string;
	entries: Array<Vst3ScanEntry>;
}

export interface RootGroup {
	rootPath: string;
	vendors: Array<VendorGroup>;
}

export function readStage(fields: ReadonlyArray<LeafParameter>): Stage {
	const get = (name: string): string => {
		const field = fields.find((candidate) => candidate.name === name);

		return field && typeof field.value === "string" ? field.value : "";
	};

	return { pluginPath: get("pluginPath"), pluginName: get("pluginName"), presetPath: get("presetPath") };
}

export function stageTitle(stage: Stage): string | null {
	if (stage.pluginName) return stage.pluginName;

	if (stage.pluginPath) return basename(stage.pluginPath).replace(/\.vst3$/i, "");

	return null;
}

export function groupEntries(entries: ReadonlyArray<Vst3ScanEntry>): Array<RootGroup> {
	const roots: Array<RootGroup> = [];

	for (const entry of entries) {
		let root = roots.find((candidate) => candidate.rootPath === entry.rootPath);

		if (!root) {
			root = { rootPath: entry.rootPath, vendors: [] };
			roots.push(root);
		}

		let vendor = root.vendors.find((candidate) => candidate.vendorFolder === entry.vendorFolder);

		if (!vendor) {
			vendor = { vendorFolder: entry.vendorFolder, entries: [] };
			root.vendors.push(vendor);
		}

		vendor.entries.push(entry);
	}

	return roots;
}
