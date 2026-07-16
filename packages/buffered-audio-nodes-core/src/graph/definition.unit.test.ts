import { describe, expect, it } from "vitest";
import { validateGraphDefinition } from "./definition";

describe("graph definition validation", () => {
	it("validates a graph definition", () => {
		const valid = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			apiVersion: 1,
			nodes: [
				{ id: "a", packageName: "@buffered-audio/nodes", packageVersion: "1.0.0", nodeName: "read" },
				{ id: "b", packageName: "@buffered-audio/nodes", packageVersion: "1.0.0", nodeName: "write" },
			],
			edges: [{ from: "a", to: "b" }],
		});

		expect(valid.nodes).toHaveLength(2);
	});

	it("defaults name to Untitled", () => {
		const valid = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			apiVersion: 1,
			nodes: [{ id: "a", packageName: "@buffered-audio/nodes", packageVersion: "1.0.0", nodeName: "read" }],
			edges: [],
		});

		expect(valid.name).toBe("Untitled");
	});

	it("rejects an invalid id", () => {
		expect(() =>
			validateGraphDefinition({
				id: "not-a-uuid",
				apiVersion: 1,
				nodes: [{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read" }],
				edges: [],
			}),
		).toThrow();
	});

	it("rejects a node missing packageVersion", () => {
		expect(() =>
			validateGraphDefinition({
				id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
				apiVersion: 1,
				nodes: [{ id: "a", packageName: "test", nodeName: "read" }],
				edges: [],
			}),
		).toThrow();
	});

	it("rejects a definition missing apiVersion", () => {
		expect(() =>
			validateGraphDefinition({
				id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
				name: "Test",
				nodes: [{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read" }],
				edges: [],
			}),
		).toThrow();
	});
});
