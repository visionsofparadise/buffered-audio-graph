import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { SourceNode } from "../node/stream/source";
import { TargetNode } from "../node/stream/target";
import { pack } from "./pack";

class PackSource extends SourceNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "pack-source";
	static override readonly schema = z.object({});
}

class PackTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "pack-target";
	static override readonly schema = z.object({});
}

describe("pack version resolution", () => {
	let fixtureRoot: string;
	let anchor: string;

	beforeAll(() => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "bag-pack-"));
		const packageDirectory = join(fixtureRoot, "node_modules", "test");

		mkdirSync(packageDirectory, { recursive: true });
		writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "test", version: "1.2.3" }));
		writeFileSync(join(packageDirectory, "index.js"), "module.exports = {};");
		anchor = join(fixtureRoot, "anchor.js");
		writeFileSync(anchor, "");
	});

	afterAll(() => {
		rmSync(fixtureRoot, { recursive: true, force: true });
	});

	it("pack of freshly constructed version-less nodes resolves the package version onto each node", () => {
		const source = new PackSource();
		const target = new PackTarget();

		source.to(target);

		const definition = pack([source], { anchor });

		expect(definition.nodes.map((node) => node.packageVersion)).toEqual(["1.2.3", "1.2.3"]);
		expect(definition.nodes.every((node) => node.packageVersion === "1.2.3")).toBe(true);
	});
});
