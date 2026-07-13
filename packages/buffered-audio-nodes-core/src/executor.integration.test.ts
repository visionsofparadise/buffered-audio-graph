import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Block } from "./block-buffer";
import { createRenderJobs, pack, substituteParameters, unpack, validateGraphDefinition, type GraphDefinition, type NodeRegistry } from "./graph-format";
import type { BufferedAudioNode } from "./node";
import { RenderJob } from "./render-job";
import { BufferedSourceStream, SourceNode, type SourceMetadata } from "./source";
import { BufferedTargetStream, TargetNode } from "./target";
import { UnbufferedTransformStream } from "./unbuffered-transform";
import { TransformNode } from "./transform";

function writePackageFixture(root: string, name: string, version: string): string {
	const packageDir = join(root, "node_modules", name);

	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version }));
	writeFileSync(join(packageDir, "index.js"), "module.exports = {};");

	const anchor = join(root, "anchor.js");

	writeFileSync(anchor, "");

	return anchor;
}

let packAnchor: string;
let fixtureRoot: string;

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "bag-pack-"));
	packAnchor = writePackageFixture(fixtureRoot, "test", "1.0.0");
});

afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

function createChunk(value: number, offset: number, frames: number): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate: 44100, bitDepth: 32 };
}

class MockSourceStream extends BufferedSourceStream {
	private index = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return (this.properties.meta as SourceMetadata | undefined) ?? { sampleRate: 44100, channels: 1 };
	}

	override async _read(): Promise<Block | undefined> {
		const chunks = (this.properties.chunks as Array<Block> | undefined) ?? [];
		const chunk = chunks[this.index];

		if (!chunk) return undefined;
		this.index += 1;

		return chunk;
	}
}

class MockSource extends SourceNode {
	static readonly packageName = "test";
	static readonly nodeName = "mock-source";
	static override readonly schema = z.object({});
	static override readonly Stream = MockSourceStream;

	constructor(chunks: Array<Block> = [], meta: SourceMetadata = { sampleRate: 44100, channels: 1 }) {
		super({ chunks, meta } as never);
	}
}

class MockTransformStream extends UnbufferedTransformStream {
	override *_transform(block: Block): Iterable<Block> {
		yield block;
	}
}

class MockTransform extends TransformNode {
	static readonly packageName = "test";
	static readonly nodeName = "mock-transform";
	static override readonly schema = z.object({});
	static override readonly Stream = MockTransformStream;
}

class MockTargetStream extends BufferedTargetStream {
	readonly receivedChunks: Array<Block> = [];
	closed = false;

	override async _write(chunk: Block): Promise<void> {
		this.receivedChunks.push(chunk);
	}

	override async _close(): Promise<void> {
		this.closed = true;
	}
}

class MockTarget extends TargetNode {
	static readonly packageName = "test";
	static readonly nodeName = "mock-target";
	static override readonly schema = z.object({});
	static override readonly Stream = MockTargetStream;
}

class FailingTargetStream extends BufferedTargetStream {
	destroyCount = 0;

	override async _write(): Promise<void> {
		throw new Error("write failed");
	}

	override async _close(): Promise<void> {}

	override _destroy(): void {
		this.destroyCount += 1;
	}
}

class FailingTarget extends TargetNode {
	static readonly packageName = "test";
	static readonly nodeName = "failing-target";
	static override readonly schema = z.object({});
	static override readonly Stream = FailingTargetStream;
}

function targetStream(job: RenderJob, node: TargetNode): MockTargetStream {
	return job.streams.get(node)?.[0] as MockTargetStream;
}

describe("RenderJob execution", () => {
	it("linear pipeline: source → transform → target", async () => {
		const source = new MockSource([createChunk(1, 0, 100)]);
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);

		const job = source.createRenderJob();
		await job.render();

		expect(targetStream(job, target).receivedChunks).toHaveLength(1);
		expect(targetStream(job, target).closed).toBe(true);
	});

	it("fan-out: source → two targets, both receive", async () => {
		const source = new MockSource([createChunk(1, 0, 100)]);
		const target1 = new MockTarget();
		const target2 = new MockTarget();

		source.to(target1);
		source.to(target2);

		const job = source.createRenderJob();
		await job.render();

		expect(targetStream(job, target1).receivedChunks).toHaveLength(1);
		expect(targetStream(job, target2).receivedChunks).toHaveLength(1);
	});

	it("bypass: a bypassed transform is skipped, its child wired to the source", async () => {
		const source = new MockSource([createChunk(1, 0, 100)]);
		const bypassed = new MockTransform({ bypass: true });
		const target = new MockTarget();

		source.to(bypassed);
		bypassed.to(target);

		const job = source.createRenderJob();

		expect(job.streams.has(bypassed)).toBe(false);

		await job.render();

		expect(targetStream(job, target).receivedChunks).toHaveLength(1);
	});

	it("cycle detection throws at job construction", () => {
		const source = new MockSource([]);
		const a = new MockTransform();
		const b = new MockTransform();

		source.to(a);
		a.to(b);
		b.to(a);

		expect(() => source.createRenderJob()).toThrow(/Cycle detected/);
	});

	it("second render() throws", async () => {
		const source = new MockSource([createChunk(1, 0, 100)]);
		const target = new MockTarget();

		source.to(target);

		const job = source.createRenderJob();
		await job.render();

		await expect(job.render()).rejects.toThrow(/single-use/);
	});

	it("streams map is populated at construction, before render", () => {
		const source = new MockSource([]);
		const target = new MockTarget();

		source.to(target);

		const job = source.createRenderJob();

		expect(job.streams.get(source)).toHaveLength(1);
		expect(job.streams.get(target)).toHaveLength(1);
	});

	it("fan-in duplicates: one node under two parents gets one stream per path", () => {
		const source = new MockSource([]);
		const t1 = new MockTransform();
		const t2 = new MockTransform();
		const shared = new MockTarget();

		source.to(t1);
		source.to(t2);
		t1.to(shared);
		t2.to(shared);

		const job = source.createRenderJob();

		expect(job.streams.get(shared)).toHaveLength(2);
	});

	it("timing is set after render", async () => {
		const source = new MockSource([createChunk(1, 0, 100)], { sampleRate: 44100, channels: 1, durationFrames: 100 });
		const target = new MockTarget();

		source.to(target);

		const job = source.createRenderJob();

		expect(job.timing).toBeUndefined();

		await job.render();

		expect(job.timing).toBeDefined();
		expect(job.timing?.audioDurationMs).toBeGreaterThan(0);
	});

	it("destroy backstop runs on a stream that errors mid-render", async () => {
		const source = new MockSource([createChunk(1, 0, 100)]);
		const failing = new FailingTarget();

		source.to(failing);

		const job = source.createRenderJob();

		await expect(job.render()).rejects.toThrow("write failed");

		const stream = job.streams.get(failing)?.[0] as FailingTargetStream;
		expect(stream.destroyCount).toBe(1);
	});
});

describe("render leaf-must-be-a-target validation", () => {
	it("throws on a leaf transform, naming it", () => {
		const source = new MockSource([createChunk(1, 0, 100)]);
		const transform = new MockTransform();

		source.to(transform);

		expect(() => source.createRenderJob()).toThrow(/Graph leaf "mock-transform" is not a target/);
	});

	it("throws on a childless source", () => {
		const source = new MockSource([createChunk(1, 0, 100)]);

		expect(() => source.createRenderJob()).toThrow(/Graph leaf "mock-source" is not a target/);
	});

	it("throws when the only target is bypassed", () => {
		const source = new MockSource([createChunk(1, 0, 100)]);
		const target = new MockTarget({ bypass: true });

		source.to(target);

		expect(() => source.createRenderJob()).toThrow(/is not a target/);
	});

	it("constructs a valid source → transform → target without throwing", () => {
		const source = new MockSource([createChunk(1, 0, 100)]);
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);

		expect(() => source.createRenderJob()).not.toThrow();
	});
});

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
});

describe("apiVersion enforcement", () => {
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

	it("pack writes the uniform apiVersion into the definition", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		expect(pack([source], { anchor: packAnchor }).apiVersion).toBe(1);
	});

	it("pack throws naming each offending node when statics disagree", () => {
		class VersionTwoTarget extends TargetNode {
			static readonly packageName = "test";
			static readonly nodeName = "v2-target";
			static override readonly apiVersion = 2;
			static override readonly schema = z.object({});
			static override readonly Stream = MockTargetStream;
		}

		const source = new MockSource();
		const target = new VersionTwoTarget();
		source.to(target);

		expect(() => pack([source], { anchor: packAnchor })).toThrow(/differing apiVersions/);
		expect(() => pack([source], { anchor: packAnchor })).toThrow(/"v2-target" \(apiVersion 2\)/);
	});

	it("unpack throws when a resolved class's apiVersion differs from the bag's", () => {
		class VersionTwoSource extends SourceNode {
			static readonly packageName = "test";
			static readonly nodeName = "v2-source";
			static override readonly apiVersion = 2;
			static override readonly schema = z.object({});
			static override readonly Stream = MockSourceStream;
		}

		const registry: NodeRegistry = new Map([
			[
				"test",
				new Map([["1.0.0", new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([["v2-source", VersionTwoSource as never]])]]),
			],
		]);

		const definition = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			apiVersion: 1,
			nodes: [{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "v2-source" }],
			edges: [],
		});

		expect(() => unpack(definition, registry)).toThrow(/apiVersion mismatch/);
	});
});

describe("pack version resolution", () => {
	let goodAnchor: string;
	let mismatchAnchor: string;
	let emptyDir: string;
	let resolutionRoot: string;

	beforeAll(() => {
		resolutionRoot = mkdtempSync(join(tmpdir(), "bag-resolve-"));
		goodAnchor = writePackageFixture(join(resolutionRoot, "good"), "test", "1.2.3");
		mismatchAnchor = writePackageFixture(join(resolutionRoot, "mismatch"), "test", "9.9.9");

		const mismatchPackageJson = join(resolutionRoot, "mismatch", "node_modules", "test", "package.json");

		writeFileSync(mismatchPackageJson, JSON.stringify({ name: "not-test", version: "9.9.9" }));

		emptyDir = join(resolutionRoot, "empty");
		mkdirSync(emptyDir, { recursive: true });
	});

	afterAll(() => {
		rmSync(resolutionRoot, { recursive: true, force: true });
	});

	it("resolves each package's version from package.json onto each node", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		const definition = pack([source], { anchor: goodAnchor });

		expect(definition.nodes.map((node) => node.packageVersion)).toEqual(["1.2.3", "1.2.3"]);
	});

	it("throws naming the package, anchor, and remedy when the name does not match", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		expect(() => pack([source], { anchor: mismatchAnchor })).toThrow(/"test".*not-test.*anchor: import\.meta\.url/s);
	});

	it("throws naming the package and remedy when the package cannot be resolved", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		expect(() => pack([source], { anchor: emptyDir })).toThrow(/resolve package "test".*anchor: import\.meta\.url/s);
	});
});

describe("pack id round-trip", () => {
	it("pack preserves a provided id", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

		expect(pack([source], { name: "Test", id, anchor: packAnchor }).id).toBe(id);
	});

	it("pack generates an id when absent", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		expect(pack([source], { name: "Test", anchor: packAnchor }).id).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("unpack applies node schema defaults (2026-05-19 regression)", () => {
	it("applies a defaulted field the bag omits, keeps explicit values, and injects the id", () => {
		class DefaultingTransform extends TransformNode {
			static readonly packageName = "test";
			static readonly nodeName = "defaulting-transform";
			static override readonly schema = z.object({
				frameSize: z.number().default(2048),
				smoothing: z.number().default(100),
			});
			static override readonly Stream = MockTransformStream;
		}

		const registry: NodeRegistry = new Map([
			[
				"test",
				new Map([
					[
						"1.0.0",
						new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
							["mock-source", MockSource as never],
							["defaulting-transform", DefaultingTransform as never],
						]),
					],
				]),
			],
		]);

		const definition = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			apiVersion: 1,
			nodes: [
				{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "mock-source" },
				{ id: "t", packageName: "test", packageVersion: "1.0.0", nodeName: "defaulting-transform", parameters: { smoothing: 30 } },
			],
			edges: [{ from: "s", to: "t" }],
		});

		const sources = unpack(definition, registry);
		const source = sources[0];
		const transform = source?.properties.children?.[0] as DefaultingTransform | undefined;

		expect(transform?.id).toBe("t");
		expect(transform?.properties.frameSize).toBe(2048);
		expect(transform?.properties.smoothing).toBe(30);
	});
});

describe("mixed-version bags — per-node pins", () => {
	class VersionedSource extends SourceNode {
		static readonly packageName = "test";
		static readonly nodeName = "versioned-source";
		static override readonly schema = z.object({});
		static override readonly Stream = MockSourceStream;
	}

	class VersionedTarget extends TargetNode {
		static readonly packageName = "test";
		static readonly nodeName = "versioned-target";
		static override readonly schema = z.object({});
		static override readonly Stream = MockTargetStream;
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

	const mixedDefinition = validateGraphDefinition({
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		name: "Test",
		apiVersion: 1,
		nodes: [
			{ id: "s", packageName: "test", packageVersion: "0.20.0", nodeName: "versioned-source" },
			{ id: "t", packageName: "test", packageVersion: "0.22.0", nodeName: "versioned-target" },
		],
		edges: [{ from: "s", to: "t" }],
	});

	it("unpack resolves two versions of one package in a single bag and injects each pin", () => {
		const sources = unpack(mixedDefinition, registry);
		const source = sources[0];
		const target = source?.children[0];

		expect(source?.packageVersion).toBe("0.20.0");
		expect(target?.packageVersion).toBe("0.22.0");
	});

	it("unpack→pack round-trips each carried version without an anchor (carried wins, no detection)", () => {
		const sources = unpack(mixedDefinition, registry);

		const definition = pack(sources);

		expect(definition.nodes.find((node) => node.id === "s")?.packageVersion).toBe("0.20.0");
		expect(definition.nodes.find((node) => node.id === "t")?.packageVersion).toBe("0.22.0");
	});

	it("pack of a freshly constructed version-less node detects via the anchor", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		const definition = pack([source], { anchor: packAnchor });

		expect(definition.nodes.every((node) => node.packageVersion === "1.0.0")).toBe(true);
	});

	it("unpack names the name@version pair when the pinned version is unknown", () => {
		const definition = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			apiVersion: 1,
			nodes: [{ id: "s", packageName: "test", packageVersion: "9.9.9", nodeName: "versioned-source" }],
			edges: [],
		});

		expect(() => unpack(definition, registry)).toThrow(/Unknown package: "test@9\.9\.9"/);
	});
});

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
		const parameters = result.nodes[0]?.parameters as Record<string, unknown>;

		expect(parameters.path).toBe("e260/raw.wav");
		expect(parameters.chain).toEqual([{ plugin: { preset: "warm" } }, "end"]);
		expect(parameters.count).toBe(5);
	});

	it("does not mutate the input definition", () => {
		const definition = templatedDefinition([{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{episode}}/in.wav" } }]);
		const snapshot = structuredClone(definition);

		substituteParameters(definition, { episode: "e260" });

		expect(definition).toEqual(snapshot);
	});

	it("throws naming every unbound placeholder at once", () => {
		const definition = templatedDefinition([
			{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{one}}/{{two}}/{{three}}.wav" } },
		]);

		expect(() => substituteParameters(definition, { two: "x" })).toThrow(/unbound placeholders: one, three/);
	});

	it("throws naming an unknown provided parameter", () => {
		const definition = templatedDefinition([{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{used}}.wav" } }]);

		expect(() => substituteParameters(definition, { used: "x", extra: "y" })).toThrow(/unknown parameters: extra/);
	});
});

class PathSourceStream extends BufferedSourceStream {
	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1 };
	}

	override async _read(): Promise<Block | undefined> {
		if (this.properties.done) return undefined;
		(this.properties as Record<string, unknown>).done = true;

		return createChunk(1, 0, 10);
	}
}

class PathSource extends SourceNode {
	static readonly packageName = "test";
	static readonly nodeName = "path-source";
	static override readonly schema = z.object({ path: z.string() });
	static override readonly Stream = PathSourceStream;
}

const capturedPaths: Array<string> = [];

class PathTargetStream extends BufferedTargetStream {
	override async _write(): Promise<void> {}
	override async _close(): Promise<void> {
		capturedPaths.push(this.properties.path as string);
	}
}

class PathTarget extends TargetNode {
	static readonly packageName = "test";
	static readonly nodeName = "path-target";
	static override readonly schema = z.object({ path: z.string() });
	static override readonly Stream = PathTargetStream;
}

describe("createRenderJobs parameter substitution", () => {
	const registry: NodeRegistry = new Map([
		[
			"test",
			new Map([
				[
					"1.0.0",
					new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
						["path-source", PathSource as never],
						["path-target", PathTarget as never],
					]),
				],
			]),
		],
	]);

	const definition: GraphDefinition = {
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		name: "Test",
		apiVersion: 1,
		nodes: [
			{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "path-source", parameters: { path: "{{dir}}/in.wav" } },
			{ id: "t", packageName: "test", packageVersion: "1.0.0", nodeName: "path-target", parameters: { path: "{{dir}}/out.wav" } },
		],
		edges: [{ from: "s", to: "t" }],
	};

	it("renders the same definition twice with different parameters, each seeing its own values", async () => {
		capturedPaths.length = 0;

		for (const job of createRenderJobs(definition, registry, { parameters: { dir: "e260" } })) await job.render();
		for (const job of createRenderJobs(definition, registry, { parameters: { dir: "e261" } })) await job.render();

		expect(capturedPaths).toEqual(["e260/out.wav", "e261/out.wav"]);
	});

	it("throws before any job is created when a required parameter is missing", () => {
		expect(() => createRenderJobs(definition, registry, { parameters: {} })).toThrow(/unbound placeholders: dir/);
	});
});
