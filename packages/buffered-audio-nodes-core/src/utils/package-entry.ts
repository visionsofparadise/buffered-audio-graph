export type PackageExports = string | Array<PackageExports> | { [key: string]: PackageExports } | null | undefined;

export interface PackageEntryManifest {
	readonly exports?: PackageExports | { ".": PackageExports };
	readonly main?: string;
	readonly module?: string;
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

export function collectPackageEntryCandidates(manifest: PackageEntryManifest): Array<string> {
	const rootExports =
		manifest.exports &&
		typeof manifest.exports === "object" &&
		!Array.isArray(manifest.exports) &&
		"." in manifest.exports
			? manifest.exports["."]
			: manifest.exports;

	const candidates = [
		...collectExportEntries(rootExports),
		...(manifest.module ? [manifest.module] : []),
		...(manifest.main ? [manifest.main] : []),
	];

	return candidates.filter((candidate) => candidate !== "" && !candidate.startsWith("#"));
}
