import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BufferedAudioNode } from "../node";
import { SourceNode } from "../node/stream/source";
import { TargetNode } from "../node/stream/target";
import { TransformNode, type TransformNodeProperties } from "../node/transform";
import { validateGraphDefinition, type GraphDefinition, type NodeRegistry } from "./definition";
import { unpack } from "./unpack";

class VersionedSource extends SourceNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "versioned-source";
	static override readonly schema = z.object({});
}

class VersionedTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "versioned-target";
	static override readonly schema = z.object({});
}

function versionMap(): Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode> {
	return new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
		["versioned-source", VersionedSource as never],
		["versioned-target", VersionedTarget as never],
	]);
}

const registry: NodeRegistry = new Map([
	[
		"test",
		new Map([
			["0.20.0", versionMap()],
			["0.22.0", versionMap()],
		]),
	],
]);

function graph(nodes: GraphDefinition["nodes"], edges: GraphDefinition["edges"] = []): GraphDefinition {
	return validateGraphDefinition({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", name: "Test", apiVersion: 1, nodes, edges });
}

describe("unpack apiVersion enforcement", () => {
	it("unpack throws when a resolved class's apiVersion differs from the bag's", () => {
		class VersionTwoSource extends SourceNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "v2-source";
			static override readonly apiVersion = 2;
			static override readonly schema = z.object({});
		}

		const versionTwoRegistry: NodeRegistry = new Map([
			["test", new Map([["1.0.0", new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([["v2-source", VersionTwoSource as never]])]])],
		]);
		const definition = graph([{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "v2-source" }]);

		expect(() => unpack(definition, versionTwoRegistry)).toThrow(/apiVersion mismatch/);
	});
});

describe("unpack applies node schema defaults (2026-05-19 regression)", () => {
	it("applies a defaulted field the bag omits, keeps explicit values, and injects the id", () => {
		interface DefaultingTransformProperties extends TransformNodeProperties {
			readonly frameSize: number;
			readonly smoothing: number;
		}

		class DefaultingTransform extends TransformNode<DefaultingTransformProperties> {
			static override readonly packageName = "test";
			static override readonly nodeName = "defaulting-transform";
			static override readonly schema = z.object({
				frameSize: z.number().default(2048),
				smoothing: z.number().default(100),
			});
		}

		const defaultingRegistry: NodeRegistry = new Map([
			[
				"test",
				new Map([
					[
						"1.0.0",
						new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
							["versioned-source", VersionedSource as never],
							["defaulting-transform", DefaultingTransform as never],
						]),
					],
				]),
			],
		]);
		const definition = graph(
			[
				{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "versioned-source" },
				{ id: "t", packageName: "test", packageVersion: "1.0.0", nodeName: "defaulting-transform", parameters: { smoothing: 30 } },
			],
			[{ from: "s", to: "t" }],
		);

		const sources = unpack(definition, defaultingRegistry);
		const transform = sources[0]?.properties.children?.[0] as DefaultingTransform | undefined;

		expect(transform?.id).toBe("t");
		expect(transform?.properties.frameSize).toBe(2048);
		expect(transform?.properties.smoothing).toBe(30);
	});
});

describe("mixed-version bags — per-node pins", () => {
	const mixedDefinition = graph(
		[
			{ id: "s", packageName: "test", packageVersion: "0.20.0", nodeName: "versioned-source" },
			{ id: "t", packageName: "test", packageVersion: "0.22.0", nodeName: "versioned-target" },
		],
		[{ from: "s", to: "t" }],
	);

	it("unpack resolves two versions of one package in a single bag and injects each pin", () => {
		const sources = unpack(mixedDefinition, registry);
		const source = sources[0];
		const target = source?.children[0];

		expect(source?.packageVersion).toBe("0.20.0");
		expect(target?.packageVersion).toBe("0.22.0");
	});

	it("unpack names the name@version pair when the pinned version is unknown", () => {
		const definition = graph([{ id: "s", packageName: "test", packageVersion: "9.9.9", nodeName: "versioned-source" }]);

		expect(() => unpack(definition, registry)).toThrow(/Unknown package: "test@9\.9\.9"/);
	});
});

describe("unpack graph errors", () => {
	it("throws when the pinned package version has no requested node", () => {
		const definition = graph([{ id: "s", packageName: "test", packageVersion: "0.20.0", nodeName: "missing" }]);

		expect(() => unpack(definition, registry)).toThrow('Unknown node: "missing" in package "test@0.20.0"');
	});

	it("throws when an edge references an unknown node", () => {
		const definition = graph([{ id: "s", packageName: "test", packageVersion: "0.20.0", nodeName: "versioned-source" }], [{ from: "s", to: "missing" }]);

		expect(() => unpack(definition, registry)).toThrow('Edge references unknown node: "missing"');
	});

	it("throws when an edge connects from a target", () => {
		const definition = graph(
			[
				{ id: "t", packageName: "test", packageVersion: "0.20.0", nodeName: "versioned-target" },
				{ id: "s", packageName: "test", packageVersion: "0.20.0", nodeName: "versioned-source" },
			],
			[{ from: "t", to: "s" }],
		);

		expect(() => unpack(definition, registry)).toThrow('Cannot connect from target node "t"');
	});

	it("throws when the graph has no source node", () => {
		const definition = graph([{ id: "t", packageName: "test", packageVersion: "0.20.0", nodeName: "versioned-target" }]);

		expect(() => unpack(definition, registry)).toThrow("No source nodes found in graph definition");
	});
});
