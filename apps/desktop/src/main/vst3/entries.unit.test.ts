import { describe, expect, it } from "vitest";

import { buildEntryKey } from "../../shared/ipc/Vst3/Vst3ScanEntry";
import { deriveErrorEntry, derivePendingEntry, deriveReadyEntries } from "./entries";
import type { WalkModule } from "./walk";

const walkModule: WalkModule = {
	modulePath: "/root/VendorA/Synth.vst3",
	rootPath: "/root",
	vendorFolder: "VendorA",
	name: "Synth",
};

describe("derivePendingEntry", () => {
	it("carries the module fields with status pending", () => {
		expect(derivePendingEntry(walkModule)).toEqual({
			entryKey: buildEntryKey(walkModule.modulePath),
			name: walkModule.name,
			modulePath: walkModule.modulePath,
			rootPath: walkModule.rootPath,
			vendorFolder: walkModule.vendorFolder,
			status: "pending",
		});
	});
});

describe("deriveReadyEntries", () => {
	it("returns a single entry named after the module with no className, for zero or one class name", () => {
		const singleEntryKey = buildEntryKey(walkModule.modulePath);
		const expectedEntry = {
			entryKey: singleEntryKey,
			name: walkModule.name,
			modulePath: walkModule.modulePath,
			rootPath: walkModule.rootPath,
			vendorFolder: walkModule.vendorFolder,
			status: "ready",
		};

		expect(deriveReadyEntries(walkModule, [])).toEqual([expectedEntry]);
		expect(deriveReadyEntries(walkModule, ["ClassA"])).toEqual([expectedEntry]);
	});

	it("returns one entry per class name, keyed distinctly from each other and from the single-entry key", () => {
		const entries = deriveReadyEntries(walkModule, ["ClassA", "ClassB"]);
		const singleEntryKey = buildEntryKey(walkModule.modulePath);

		expect(entries).toEqual([
			{
				entryKey: buildEntryKey(walkModule.modulePath, "ClassA"),
				name: "ClassA",
				modulePath: walkModule.modulePath,
				rootPath: walkModule.rootPath,
				vendorFolder: walkModule.vendorFolder,
				className: "ClassA",
				status: "ready",
			},
			{
				entryKey: buildEntryKey(walkModule.modulePath, "ClassB"),
				name: "ClassB",
				modulePath: walkModule.modulePath,
				rootPath: walkModule.rootPath,
				vendorFolder: walkModule.vendorFolder,
				className: "ClassB",
				status: "ready",
			},
		]);

		const entryKeys = entries.map((entry) => entry.entryKey);

		expect(new Set(entryKeys).size).toBe(2);
		expect(entryKeys).not.toContain(singleEntryKey);
	});
});

describe("deriveErrorEntry", () => {
	it("carries status error and the error string", () => {
		expect(deriveErrorEntry(walkModule, "boom")).toEqual({
			entryKey: buildEntryKey(walkModule.modulePath),
			name: walkModule.name,
			modulePath: walkModule.modulePath,
			rootPath: walkModule.rootPath,
			vendorFolder: walkModule.vendorFolder,
			status: "error",
			error: "boom",
		});
	});
});
