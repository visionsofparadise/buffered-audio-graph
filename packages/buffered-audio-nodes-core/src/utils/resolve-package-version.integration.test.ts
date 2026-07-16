import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackageVersion } from "./resolve-package-version";

const roots: Array<string> = [];

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bag-resolve-"));

	roots.push(root);

	return root;
}

function writePackage(root: string, packageName: string, manifest: Record<string, unknown>): string {
	const packageDirectory = join(root, "node_modules", packageName);

	mkdirSync(packageDirectory, { recursive: true });
	writeFileSync(join(packageDirectory, "package.json"), JSON.stringify(manifest));
	writeFileSync(join(packageDirectory, "index.js"), "module.exports = {};");

	const anchor = join(root, "anchor.js");

	writeFileSync(anchor, "");

	return anchor;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolvePackageVersion", () => {
	it("discovers an exported package manifest from a file URL anchor", () => {
		const root = fixtureRoot();
		const anchor = writePackage(root, "test", { name: "test", version: "1.2.3" });

		expect(resolvePackageVersion("test", pathToFileURL(anchor).href)).toBe("1.2.3");
	});

	it("falls back to the package manifest when package.json is not exported and the anchor is a directory", () => {
		const root = fixtureRoot();

		writePackage(root, "test", { name: "test", version: "2.0.0", exports: { ".": "./index.js" } });

		expect(resolvePackageVersion("test", root)).toBe("2.0.0");
	});

	it("throws naming the package, anchor, and remedy when the package cannot be resolved", () => {
		const root = fixtureRoot();

		expect(() => resolvePackageVersion("test", root)).toThrow(/resolve package "test".*anchor: import\.meta\.url/s);
	});

	it("throws naming the package, anchor, and remedy when the name does not match", () => {
		const root = fixtureRoot();
		const anchor = writePackage(root, "test", { name: "not-test", version: "9.9.9" });

		expect(() => resolvePackageVersion("test", anchor)).toThrow(/"test".*not-test.*anchor: import\.meta\.url/s);
	});

	it("throws naming the package, anchor, and remedy when the manifest has no version", () => {
		const root = fixtureRoot();
		const anchor = writePackage(root, "test", { name: "test" });

		expect(() => resolvePackageVersion("test", anchor)).toThrow(/"test".*no version.*anchor: import\.meta\.url/s);
	});
});
