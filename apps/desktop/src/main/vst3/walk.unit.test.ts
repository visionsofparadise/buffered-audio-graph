import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isModuleDirent, moduleNameFromPath, walkRoot, type DirentLike, type ReadDirectory } from "./walk";

const file = (name: string): DirentLike => ({ name, isDirectory: () => false });
const dir = (name: string): DirentLike => ({ name, isDirectory: () => true });

const fakeReadDirectory = (tree: Record<string, ReadonlyArray<DirentLike>>): ReadDirectory => (directory) => {
	const entries = tree[directory];

	if (!entries) throw new Error(`no fixture entries for ${directory}`);

	return entries;
};

describe("isModuleDirent", () => {
	it("is true for .vst3 and .VST3 names, for a file or a directory dirent", () => {
		expect(isModuleDirent(file("Synth.vst3"))).toBe(true);
		expect(isModuleDirent(dir("Synth.VST3"))).toBe(true);
	});

	it("is false for other names", () => {
		expect(isModuleDirent(file("Synth.dll"))).toBe(false);
		expect(isModuleDirent(dir("Synth"))).toBe(false);
	});
});

describe("moduleNameFromPath", () => {
	it("strips the .vst3 extension case-insensitively", () => {
		expect(moduleNameFromPath("/root/Synth.vst3")).toBe("Synth");
		expect(moduleNameFromPath("/root/Synth.VST3")).toBe("Synth");
	});
});

describe("walkRoot", () => {
	it("assigns vendorFolder from the enclosing directory and collects a vst3 directory dirent without recursing into it", () => {
		const root = "/root";
		const vendorADir = path.join(root, "VendorA");
		const otherDir = path.join(root, "Other");
		const subDir = path.join(otherDir, "Sub");
		const readDirectory = fakeReadDirectory({
			[root]: [file("Standalone.vst3"), dir("VendorA"), dir("Other")],
			[vendorADir]: [dir("Plugin.vst3")],
			[otherDir]: [dir("Sub")],
			[subDir]: [file("Nested.vst3")],
		});

		const modules = walkRoot(root, readDirectory);

		expect(modules).toHaveLength(3);

		const standalone = modules.find((module) => module.name === "Standalone");
		const plugin = modules.find((module) => module.name === "Plugin");
		const nested = modules.find((module) => module.name === "Nested");

		expect(standalone?.vendorFolder).toBe("Standalone.vst3");
		expect(plugin?.vendorFolder).toBe("VendorA");
		expect(nested?.vendorFolder).toBe("Other");
	});

	it("invokes onWarn for an unreadable directory and continues walking sibling directories", () => {
		const root = "/broken";
		const badDir = path.join(root, "BadDir");
		const goodDir = path.join(root, "GoodDir");
		const error = new Error("permission denied");
		const readDirectory: ReadDirectory = (directory) => {
			if (directory === badDir) throw error;

			const tree: Record<string, ReadonlyArray<DirentLike>> = {
				[root]: [dir("BadDir"), dir("GoodDir")],
				[goodDir]: [file("Sibling.vst3")],
			};
			const entries = tree[directory];

			if (!entries) throw new Error(`no fixture entries for ${directory}`);

			return entries;
		};
		const onWarn = vi.fn();

		const modules = walkRoot(root, readDirectory, onWarn);

		expect(modules).toHaveLength(1);
		expect(modules[0]?.name).toBe("Sibling");
		expect(onWarn).toHaveBeenCalledWith(badDir, error);
	});
});
