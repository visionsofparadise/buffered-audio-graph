import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REMEDY = "pass `anchor: import.meta.url` to pack(), and make sure the package is installed in this project";

function normalizeAnchor(anchor: string): string {
	const path = anchor.startsWith("file:") ? fileURLToPath(anchor) : anchor;

	try {
		if (statSync(path).isDirectory()) return join(path, "resolve-anchor.js");
	} catch {
		return path;
	}

	return path;
}

function locatePackageJson(require: ReturnType<typeof createRequire>, packageName: string, anchor: string): string {
	const searchPaths = require.resolve.paths(packageName) ?? [];

	for (const base of searchPaths) {
		const candidate = join(base, packageName, "package.json");

		if (existsSync(candidate)) return candidate;
	}

	throw new Error(`Could not resolve package "${packageName}" from anchor "${anchor}". Is "${packageName}" installed in this project? ${REMEDY}.`);
}

export function resolvePackageVersion(packageName: string, anchor: string): string {
	const require = createRequire(normalizeAnchor(anchor));

	let packageJsonPath: string;

	try {
		packageJsonPath = require.resolve(`${packageName}/package.json`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			packageJsonPath = locatePackageJson(require, packageName, anchor);
		} else {
			throw new Error(`Could not resolve package "${packageName}" from anchor "${anchor}". Is "${packageName}" installed in this project? ${REMEDY}.`);
		}
	}

	const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };

	if (parsed.name !== packageName) {
		throw new Error(`Resolved "${packageJsonPath}" for package "${packageName}" but its name is "${parsed.name}" (anchor "${anchor}"). ${REMEDY}.`);
	}

	if (parsed.version === undefined) {
		throw new Error(`Resolved "${packageJsonPath}" for package "${packageName}" but it has no version (anchor "${anchor}"). ${REMEDY}.`);
	}

	return parsed.version;
}
