import { describe, expect, it } from "vitest";
import type { GraphDefinition } from "./definition";
import { substituteParameters } from "./substitute-parameters";

function templatedDefinition(nodes: GraphDefinition["nodes"]): GraphDefinition {
	return { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", name: "Test", apiVersion: 1, nodes, edges: [] };
}

describe("substituteParameters", () => {
	it("substitutes embedded, multi-placeholder, and deeply nested string values", () => {
		const definition = templatedDefinition([
			{
				id: "a",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "read",
				parameters: {
					path: "{{episode}}/{{inputFile}}.wav",
					chain: [{ plugin: { preset: "{{preset}}" } }, "{{tail}}"],
					literal: "no-placeholders",
					count: 5,
				},
			},
		]);

		const result = substituteParameters(definition, { episode: "e260", inputFile: "raw", preset: "warm", tail: "end" });
		const parameters = result.nodes[0]?.parameters;

		expect(parameters?.path).toBe("e260/raw.wav");
		expect(parameters?.chain).toEqual([{ plugin: { preset: "warm" } }, "end"]);
		expect(parameters?.count).toBe(5);
	});

	it("does not mutate the input definition", () => {
		const definition = templatedDefinition([{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{episode}}/in.wav" } }]);
		const snapshot = structuredClone(definition);

		substituteParameters(definition, { episode: "e260" });

		expect(definition).toEqual(snapshot);
	});

	it("throws naming every unbound placeholder at once", () => {
		const definition = templatedDefinition([{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{one}}/{{two}}/{{three}}.wav" } }]);

		expect(() => substituteParameters(definition, { two: "x" })).toThrow(/unbound placeholders: one, three/);
	});

	it("throws naming an unknown provided parameter", () => {
		const definition = templatedDefinition([{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{used}}.wav" } }]);

		expect(() => substituteParameters(definition, { used: "x", extra: "y" })).toThrow(/unknown parameters: extra/);
	});

	it("uses only own parameter properties and preserves error detail ordering", () => {
		const parameters = Object.create({ inherited: "wrong" });

		Object.assign(parameters, { extra: "unused" });

		const definition = templatedDefinition([{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{inherited}}" } }]);

		expect(() => substituteParameters(definition, parameters)).toThrow("Parameter substitution failed — unbound placeholders: inherited; unknown parameters: extra");
	});
});
