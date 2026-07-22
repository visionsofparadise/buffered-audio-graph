import { describe, expect, it } from "vitest";
import type { GraphDefinition } from "./definition";
import { collectParameters, substituteParameters } from "./substitute-parameters";

function templatedDefinition(nodes: GraphDefinition["nodes"]): GraphDefinition {
	return { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", name: "Test", apiVersion: 1, nodes, edges: [] };
}

describe("collectParameters", () => {
	it("returns an empty array for an untemplated definition", () => {
		const definition = templatedDefinition([
			{
				id: "a",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "read",
				parameters: { path: "plain/in.wav", count: 5 },
			},
		]);

		expect(collectParameters(definition)).toEqual([]);
	});

	it("returns a single placeholder name", () => {
		const definition = templatedDefinition([
			{
				id: "a",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "read",
				parameters: { path: "{{episode}}/in.wav" },
			},
		]);

		expect(collectParameters(definition)).toEqual(["episode"]);
	});

	it("finds placeholders nested in objects and arrays", () => {
		const definition = templatedDefinition([
			{
				id: "a",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "vst3",
				parameters: {
					path: "{{episode}}/{{inputFile}}.wav",
					chain: [{ plugin: { preset: "{{preset}}" } }, "{{tail}}"],
					literal: "no-placeholders",
					count: 5,
				},
			},
		]);

		expect(collectParameters(definition)).toEqual(["episode", "inputFile", "preset", "tail"]);
	});

	it("dedupes names across nodes and returns them sorted", () => {
		const definition = templatedDefinition([
			{
				id: "b",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "write",
				parameters: { path: "{{zeta}}/{{alpha}}.wav" },
			},
			{
				id: "a",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "read",
				parameters: { path: "{{alpha}}/in.wav", tag: "{{middle}}" },
			},
		]);

		expect(collectParameters(definition)).toEqual(["alpha", "middle", "zeta"]);
	});

	it("scans only node parameters, ignoring placeholders in nodeName and options", () => {
		const definition = templatedDefinition([
			{
				id: "a",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "{{ignoredName}}",
				parameters: { path: "{{used}}/in.wav" },
				options: { bypass: false },
			},
		]);

		(definition.nodes[0] as { options?: Record<string, unknown> }).options = {
			bypass: false,
			label: "{{ignoredOption}}",
		};

		expect(collectParameters(definition)).toEqual(["used"]);
	});

	it("returns exactly the names substituteParameters requires", () => {
		const definition = templatedDefinition([
			{
				id: "a",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "read",
				parameters: {
					path: "{{episode}}/{{inputFile}}.wav",
					chain: [{ plugin: { preset: "{{preset}}" } }, "{{tail}}"],
				},
			},
		]);

		const names = collectParameters(definition);
		const values = Object.fromEntries(names.map((name) => [name, "x"]));

		expect(() => substituteParameters(definition, values)).not.toThrow();

		const [firstName] = names;

		if (firstName === undefined) throw new Error("expected at least one name");

		const { [firstName]: _removed, ...missingOne } = values;

		expect(() => substituteParameters(definition, missingOne)).toThrow(/unbound placeholders/);
	});
});
