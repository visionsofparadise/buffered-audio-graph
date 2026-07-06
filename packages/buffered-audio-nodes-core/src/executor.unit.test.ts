import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BlockBuffer } from "./block-buffer";
import { pack, renderGraph, substituteParameters, unpack, validateGraphDefinition, type GraphDefinition, type NodeRegistry } from "./graph-format";
import type { Block, BufferedAudioNode } from "./node";
import type { SourceMetadata } from "./source";
import { BufferedSourceStream, SourceNode } from "./source";
import { BufferedTargetStream, TargetNode } from "./target";
import { BufferedTransformStream, TransformNode } from "./transform";

class MockSourceStream extends BufferedSourceStream {
	override async getMetadata(): Promise<SourceMetadata> {
		return this.properties.meta as SourceMetadata;
	}

	override async _read(): Promise<Block | undefined> {
		const chunks = this.properties.chunks as Array<Block>;
		const index = this.properties.chunkIndex as number;
		const chunk = chunks[index];
		if (chunk) {
			(this.properties as Record<string, unknown>).chunkIndex = index + 1;
			return chunk;
		}
		return undefined;
	}

	override async _flush(): Promise<void> {}
}

class MockSource extends SourceNode {
	static readonly packageName = "test";
	static readonly nodeName = "mock-source";
	static override readonly schema = z.object({});

	readonly type = ["buffered-audio-node", "source", "mock"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	constructor(chunks: Array<Block> = [], meta: SourceMetadata = { sampleRate: 44100, channels: 1 }) {
		super({ chunks, meta, chunkIndex: 0 } as never);
	}

	protected override createStream(): MockSourceStream {
		return new MockSourceStream(this.properties);
	}

	clone(): MockSource {
		return new MockSource();
	}
}

class MockTransformStream extends BufferedTransformStream {
	readonly processedChunks: Array<Block> = [];

	override async _buffer(chunk: Block, buffer: BlockBuffer): Promise<void> {
		await super._buffer(chunk, buffer);
		this.processedChunks.push(chunk);
	}
}

class MockTransform extends TransformNode {
	readonly type = ["buffered-audio-node", "transform", "mock"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	private _lastStream?: MockTransformStream;

	get processedChunks(): Array<Block> {
		return this._lastStream?.processedChunks ?? [];
	}

	override createStream(): MockTransformStream {
		this._lastStream = new MockTransformStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
		return this._lastStream;
	}

	clone(): MockTransform {
		return new MockTransform();
	}
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

	readonly type = ["buffered-audio-node", "target", "mock"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	private _lastStream?: MockTargetStream;

	get lastCreatedStream(): MockTargetStream | undefined {
		return this._lastStream;
	}

	override createStream(): MockTargetStream {
		this._lastStream = new MockTargetStream(this.properties as unknown as Record<string, unknown>);
		return this._lastStream;
	}

	clone(): MockTarget {
		return new MockTarget();
	}
}

function createChunk(value: number, offset: number, duration: number): Block {
	const samples = new Float32Array(duration).fill(value);
	return { samples: [samples], offset, sampleRate: 44100, bitDepth: 32 };
}

describe("Graph executor", () => {
	it("linear pipeline: source → transform → target", async () => {
		const chunks = [createChunk(1.0, 0, 100)];
		const source = new MockSource(chunks, { sampleRate: 44100, channels: 1 });
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);
		await source.render();

		expect(transform.processedChunks).toHaveLength(1);
		expect(target.lastCreatedStream?.receivedChunks).toHaveLength(1);
		expect(target.lastCreatedStream?.closed).toBe(true);
	});

	it("fan-out: source → two targets", async () => {
		const chunks = [createChunk(1.0, 0, 100)];
		const source = new MockSource(chunks, { sampleRate: 44100, channels: 1 });
		const target1 = new MockTarget();
		const target2 = new MockTarget();

		source.to(target1);
		source.to(target2);
		await source.render();

		expect(target1.lastCreatedStream?.receivedChunks).toHaveLength(1);
		expect(target2.lastCreatedStream?.receivedChunks).toHaveLength(1);
		expect(target1.lastCreatedStream?.closed).toBe(true);
		expect(target2.lastCreatedStream?.closed).toBe(true);
	});

	it("fan-out through transform: source → transform → two targets", async () => {
		const chunks = [createChunk(0.5, 0, 100)];
		const source = new MockSource(chunks, { sampleRate: 44100, channels: 1 });
		const transform = new MockTransform();
		const target1 = new MockTarget();
		const target2 = new MockTarget();

		source.to(transform);
		transform.to(target1);
		transform.to(target2);
		await source.render();

		expect(transform.processedChunks).toHaveLength(1);
		expect(target1.lastCreatedStream?.receivedChunks).toHaveLength(1);
		expect(target2.lastCreatedStream?.receivedChunks).toHaveLength(1);
	});

	it("cycle detection throws", async () => {
		const source = new MockSource([], { sampleRate: 44100, channels: 1 });
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);
		transform.to(target);

		await expect(source.render()).rejects.toThrow("Cycle detected");
	});

	it("validates graph definition schema", () => {
		const valid = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			nodes: [
				{ id: "a", packageName: "@buffered-audio/nodes", packageVersion: "1.0.0", nodeName: "read" },
				{ id: "b", packageName: "@buffered-audio/nodes", packageVersion: "1.0.0", nodeName: "write" },
			],
			edges: [{ from: "a", to: "b" }],
		});

		expect(valid.name).toBe("Test");
		expect(valid.nodes).toHaveLength(2);
		expect(valid.edges).toHaveLength(1);
	});

	it("validates graph definition with default name", () => {
		const valid = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			nodes: [{ id: "a", packageName: "@buffered-audio/nodes", packageVersion: "1.0.0", nodeName: "read" }],
			edges: [],
		});

		expect(valid.name).toBe("Untitled");
	});

	it("rejects invalid graph definition", () => {
		expect(() =>
			validateGraphDefinition({
				nodes: [{ id: "", packageName: "test", packageVersion: "1.0.0", nodeName: "read" }],
				edges: [],
			}),
		).toThrow();
	});

	it("validates graph definition with id", () => {
		const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		const valid = validateGraphDefinition({
			id,
			name: "Test",
			nodes: [{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read" }],
			edges: [],
		});

		expect(valid.id).toBe(id);
	});

	it("rejects graph definition with invalid id", () => {
		expect(() =>
			validateGraphDefinition({
				id: "not-a-uuid",
				nodes: [{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read" }],
				edges: [],
			}),
		).toThrow();
	});

	it("rejects graph definition without id", () => {
		expect(() =>
			validateGraphDefinition({
				nodes: [{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read" }],
				edges: [],
			}),
		).toThrow();
	});

	it("pack preserves id", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		const definition = pack([source], { name: "Test", id });

		expect(definition.id).toBe(id);
	});

	it("pack without id generates one", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		const definition = pack([source], { name: "Test" });

		expect(definition.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("unpack applies node schema defaults to bag parameters omitting a defaulted field", () => {
		class DefaultingTransformNode extends TransformNode {
			static readonly packageName = "test";
			static readonly nodeName = "defaulting-transform";
			static override readonly schema = z.object({
				frameSize: z.number().default(2048),
				smoothing: z.number().default(100),
			});

			readonly type = ["buffered-audio-node", "transform", "mock"] as const;
			get bufferSize(): number { return 0; }
			get latency(): number { return 0; }

			override createStream(): never {
				throw new Error("not exercised — unpack instantiation only");
			}

			clone(): DefaultingTransformNode {
				return new DefaultingTransformNode();
			}
		}

		const registry: NodeRegistry = new Map([
			[
				"test",
				new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
					["mock-source", MockSource as never],
					["defaulting-transform", DefaultingTransformNode as never],
				]),
			],
		]);

		const definition = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			nodes: [
				{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "mock-source" },
				{ id: "t", packageName: "test", packageVersion: "1.0.0", nodeName: "defaulting-transform", parameters: { smoothing: 30 } },
			],
			edges: [{ from: "s", to: "t" }],
		});

		const sources = unpack(definition, registry);
		const transform = sources[0]?.properties.children?.[0] as DefaultingTransformNode | undefined;

		expect(transform?.properties.frameSize).toBe(2048); // schema default applied
		expect(transform?.properties.smoothing).toBe(30); // explicit value preserved
	});
});

function templatedDefinition(nodes: GraphDefinition["nodes"]): GraphDefinition {
	return { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", name: "Test", nodes, edges: [] };
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
		expect(parameters.literal).toBe("no-placeholders");
		expect(parameters.count).toBe(5);
	});

	it("does not mutate the input definition", () => {
		const definition = templatedDefinition([
			{
				id: "a",
				packageName: "test",
				packageVersion: "1.0.0",
				nodeName: "read",
				parameters: { path: "{{episode}}/in.wav", nested: { key: "{{episode}}" }, list: ["{{episode}}"] },
			},
		]);
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
		const definition = templatedDefinition([
			{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{used}}.wav" } },
		]);

		expect(() => substituteParameters(definition, { used: "x", extra: "y" })).toThrow(/unknown parameters: extra/);
	});

	it("reports both unbound and unknown classes when both occur", () => {
		const definition = templatedDefinition([
			{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{missing}}.wav" } },
		]);

		expect(() => substituteParameters(definition, { extra: "y" })).toThrow(/unbound placeholders: missing.*unknown parameters: extra/);
	});

	it("no placeholders and no parameters is equivalent to the input", () => {
		const definition = templatedDefinition([
			{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "literal.wav" } },
		]);

		expect(substituteParameters(definition, {})).toEqual(definition);
	});

	it("validateGraphDefinition accepts a templated bag", () => {
		const definition = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			nodes: [{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{episode}}/in.wav" } }],
			edges: [],
		});

		expect((definition.nodes[0]?.parameters as Record<string, unknown>).path).toBe("{{episode}}/in.wav");
	});

	it("treats a placeholder colliding with an Object.prototype name as ordinary", () => {
		const definition = templatedDefinition([
			{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{toString}}.wav" } },
		]);

		expect((substituteParameters(definition, { toString: "master" }).nodes[0]?.parameters as Record<string, unknown>).path).toBe("master.wav");
		expect(() => substituteParameters(definition, {})).toThrow(/unbound placeholders: toString/);
	});
});

class PathSourceStream extends BufferedSourceStream {
	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1 };
	}

	override async _read(): Promise<Block | undefined> {
		if (this.properties.done) return undefined;
		(this.properties as Record<string, unknown>).done = true;
		return createChunk(1.0, 0, 10);
	}

	override async _flush(): Promise<void> {}
}

class PathSource extends SourceNode {
	static readonly packageName = "test";
	static readonly nodeName = "path-source";
	static override readonly schema = z.object({ path: z.string() });

	readonly type = ["buffered-audio-node", "source", "mock"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	protected override createStream(): PathSourceStream {
		return new PathSourceStream(this.properties);
	}

	clone(): PathSource {
		return new PathSource(this.properties);
	}
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

	readonly type = ["buffered-audio-node", "target", "mock"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	override createStream(): PathTargetStream {
		return new PathTargetStream(this.properties as unknown as Record<string, unknown>);
	}

	clone(): PathTarget {
		return new PathTarget(this.properties);
	}
}

describe("renderGraph parameter substitution", () => {
	const registry: NodeRegistry = new Map([
		[
			"test",
			new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
				["path-source", PathSource as never],
				["path-target", PathTarget as never],
			]),
		],
	]);

	const definition: GraphDefinition = {
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		name: "Test",
		nodes: [
			{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "path-source", parameters: { path: "{{dir}}/in.wav" } },
			{ id: "t", packageName: "test", packageVersion: "1.0.0", nodeName: "path-target", parameters: { path: "{{dir}}/out.wav" } },
		],
		edges: [{ from: "s", to: "t" }],
	};

	it("renders the same definition twice with different parameters, each seeing its own values", async () => {
		capturedPaths.length = 0;

		await renderGraph(definition, registry, { parameters: { dir: "e260" } });
		await renderGraph(definition, registry, { parameters: { dir: "e261" } });

		expect(capturedPaths).toEqual(["e260/out.wav", "e261/out.wav"]);
	});

	it("throws before any stream is created when a required parameter is missing", async () => {
		capturedPaths.length = 0;

		await expect(renderGraph(definition, registry, { parameters: {} })).rejects.toThrow(/unbound placeholders: dir/);
		expect(capturedPaths).toHaveLength(0);
	});

	it("throws the node Zod error when a placeholder resolves into a numeric field", async () => {
		class CeilingTarget extends TargetNode {
			static readonly packageName = "test";
			static readonly nodeName = "ceiling-target";
			static override readonly schema = z.object({ ceiling: z.number() });

			readonly type = ["buffered-audio-node", "target", "mock"] as const;
			get bufferSize(): number { return 0; }
			get latency(): number { return 0; }

			override createStream(): never {
				throw new Error("not exercised — unpack parse rejects first");
			}

			clone(): CeilingTarget {
				return new CeilingTarget(this.properties);
			}
		}

		const numericRegistry: NodeRegistry = new Map([
			[
				"test",
				new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
					["path-source", PathSource as never],
					["ceiling-target", CeilingTarget as never],
				]),
			],
		]);

		const numericDefinition: GraphDefinition = {
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
			nodes: [
				{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "path-source", parameters: { path: "d/in.wav" } },
				{ id: "t", packageName: "test", packageVersion: "1.0.0", nodeName: "ceiling-target", parameters: { ceiling: "{{c}}" } },
			],
			edges: [{ from: "s", to: "t" }],
		};

		await expect(renderGraph(numericDefinition, numericRegistry, { parameters: { c: "-1" } })).rejects.toThrow();
	});
});
