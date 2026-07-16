import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BufferedAudioNode } from "../node";
import { SourceNode } from "../node/stream/source";
import { TargetNode } from "../node/stream/target";
import { validateGraphDefinition, type NodeRegistry } from "./definition";
import { pack } from "./pack";
import { unpack } from "./unpack";

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

function carriedGraph(sourceVersion = "1.0.0", targetVersion = sourceVersion): PackSource {
	const source = new PackSource({ packageVersion: sourceVersion });
	const target = new PackTarget({ packageVersion: targetVersion });

	source.to(target);

	return source;
}

describe("pack apiVersion enforcement", () => {
	it("pack writes the uniform apiVersion into the definition", () => {
		expect(pack([carriedGraph()]).apiVersion).toBe(1);
	});

	it("pack throws naming each offending node when statics disagree", () => {
		class VersionTwoTarget extends TargetNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "v2-target";
			static override readonly apiVersion = 2;
			static override readonly schema = z.object({});
		}

		const source = new PackSource({ packageVersion: "1.0.0" });
		const target = new VersionTwoTarget({ packageVersion: "1.0.0" });

		source.to(target);

		expect(() => pack([source])).toThrow(/differing apiVersions/);
		expect(() => pack([source])).toThrow(/"v2-target" \(apiVersion 2\)/);
	});
});

describe("pack id round-trip", () => {
	it("pack preserves a provided id", () => {
		const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

		expect(pack([carriedGraph()], { name: "Test", id }).id).toBe(id);
	});

	it("pack generates an id when absent", () => {
		expect(pack([carriedGraph()], { name: "Test" }).id).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("pack carried package versions", () => {
	it("unpack→pack round-trips each carried version without an anchor (carried wins, no detection)", () => {
		const registry: NodeRegistry = new Map([
			[
				"test",
				new Map([
					["0.20.0", new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([["pack-source", PackSource as never]])],
					["0.22.0", new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([["pack-target", PackTarget as never]])],
				]),
			],
		]);
		const definition = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			apiVersion: 1,
			nodes: [
				{ id: "s", packageName: "test", packageVersion: "0.20.0", nodeName: "pack-source" },
				{ id: "t", packageName: "test", packageVersion: "0.22.0", nodeName: "pack-target" },
			],
			edges: [{ from: "s", to: "t" }],
		});

		const packed = pack(unpack(definition, registry));

		expect(packed.nodes.find((node) => node.id === "s")?.packageVersion).toBe("0.20.0");
		expect(packed.nodes.find((node) => node.id === "t")?.packageVersion).toBe("0.22.0");
	});
});
