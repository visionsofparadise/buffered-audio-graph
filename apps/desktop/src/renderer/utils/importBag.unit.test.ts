import type { GraphDefinition } from "@buffered-audio/core";
import { describe, expect, it } from "vitest";

import { mergeImportedBag } from "./importBag";

const buildDefinition = (overrides: Partial<GraphDefinition>): GraphDefinition => ({
	id: "00000000-0000-0000-0000-000000000000",
	name: "g",
	apiVersion: 1,
	nodes: [],
	edges: [],
	...overrides,
});

describe("mergeImportedBag", () => {
	it("throws when apiVersion differs, naming both versions", () => {
		const currentDefinition = buildDefinition({ apiVersion: 1 });
		const importedDefinition = buildDefinition({ apiVersion: 2 });

		expect(() =>
			mergeImportedBag({ currentDefinition, currentPositions: {}, importedDefinition }),
		).toThrow("Cannot import a bag on API version 2 into a bag on API version 1");
	});

	it("appends imported nodes with fresh ids after the current nodes", () => {
		const currentDefinition = buildDefinition({
			nodes: [{ id: "current-1", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Source" }],
		});
		const importedDefinition = buildDefinition({
			nodes: [
				{ id: "imported-1", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Gain" },
				{ id: "imported-2", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Write" },
			],
		});

		const result = mergeImportedBag({ currentDefinition, currentPositions: {}, importedDefinition });
		const resultIds = result.definition.nodes.map((node) => node.id);

		expect(result.importedNodeCount).toBe(2);
		expect(result.definition.nodes).toHaveLength(3);
		expect(result.definition.nodes[0]?.id).toBe("current-1");
		expect(resultIds).not.toContain("imported-1");
		expect(resultIds).not.toContain("imported-2");
	});

	it("remaps imported edges to the fresh node ids", () => {
		const currentDefinition = buildDefinition({});
		const importedDefinition = buildDefinition({
			nodes: [
				{ id: "imported-1", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Gain" },
				{ id: "imported-2", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Write" },
			],
			edges: [{ from: "imported-1", to: "imported-2" }],
		});

		const result = mergeImportedBag({ currentDefinition, currentPositions: {}, importedDefinition });
		const [fromNode, toNode] = result.definition.nodes;

		expect(result.definition.edges).toHaveLength(1);
		expect(result.definition.edges[0]).toEqual({ from: fromNode?.id, to: toNode?.id });
	});

	it("drops an imported edge whose endpoint is absent from the imported nodes", () => {
		const currentDefinition = buildDefinition({});
		const importedDefinition = buildDefinition({
			nodes: [{ id: "imported-1", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Gain" }],
			edges: [{ from: "missing", to: "imported-1" }],
		});

		const result = mergeImportedBag({ currentDefinition, currentPositions: {}, importedDefinition });

		expect(result.definition.edges).toHaveLength(0);
	});

	it("does not mutate its inputs", () => {
		const currentDefinition = buildDefinition({
			nodes: [{ id: "current-1", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Source" }],
		});
		const currentPositions = { "current-1": { x: 0, y: 0 } };
		const importedDefinition = buildDefinition({
			nodes: [{ id: "imported-1", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Gain" }],
		});
		const currentDefinitionBefore = JSON.stringify(currentDefinition);
		const currentPositionsBefore = JSON.stringify(currentPositions);
		const importedDefinitionBefore = JSON.stringify(importedDefinition);

		mergeImportedBag({ currentDefinition, currentPositions, importedDefinition });

		expect(JSON.stringify(currentDefinition)).toBe(currentDefinitionBefore);
		expect(JSON.stringify(currentPositions)).toBe(currentPositionsBefore);
		expect(JSON.stringify(importedDefinition)).toBe(importedDefinitionBefore);
	});

	it("gives every imported node a position entry and keeps every current position", () => {
		const currentDefinition = buildDefinition({
			nodes: [{ id: "current-1", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Source" }],
		});
		const currentPositions = { "current-1": { x: 5, y: 10 } };
		const importedDefinition = buildDefinition({
			nodes: [
				{ id: "imported-1", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Gain" },
				{ id: "imported-2", packageName: "pkg", packageVersion: "1.0.0", nodeName: "Write" },
			],
			edges: [{ from: "imported-1", to: "imported-2" }],
		});

		const result = mergeImportedBag({ currentDefinition, currentPositions, importedDefinition });
		const importedIds = result.definition.nodes.slice(1).map((node) => node.id);

		expect(result.positions["current-1"]).toEqual({ x: 5, y: 10 });

		for (const id of importedIds) {
			expect(result.positions[id]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
		}
	});
});
