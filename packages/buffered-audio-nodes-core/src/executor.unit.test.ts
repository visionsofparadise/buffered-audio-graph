import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChunkBuffer } from "./chunk-buffer";
import { pack, unpack, validateGraphDefinition, type NodeRegistry } from "./graph-format";
import type { AudioChunk, BufferedAudioNode } from "./node";
import type { SourceMetadata } from "./source";
import { BufferedSourceStream, SourceNode } from "./source";
import { BufferedTargetStream, TargetNode } from "./target";
import { BufferedTransformStream, TransformNode } from "./transform";

class MockSourceStream extends BufferedSourceStream {
	override async getMetadata(): Promise<SourceMetadata> {
		return this.properties.meta as SourceMetadata;
	}

	override async _read(): Promise<AudioChunk | undefined> {
		const chunks = this.properties.chunks as Array<AudioChunk>;
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
	static readonly moduleName = "mock-source";
	static override readonly schema = z.object({});

	readonly type = ["buffered-audio-node", "source", "mock"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	constructor(chunks: Array<AudioChunk> = [], meta: SourceMetadata = { sampleRate: 44100, channels: 1 }) {
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
	readonly processedChunks: Array<AudioChunk> = [];

	override async _buffer(chunk: AudioChunk, buffer: ChunkBuffer): Promise<void> {
		await super._buffer(chunk, buffer);
		this.processedChunks.push(chunk);
	}
}

class MockTransform extends TransformNode {
	readonly type = ["buffered-audio-node", "transform", "mock"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	private _lastStream?: MockTransformStream;

	get processedChunks(): Array<AudioChunk> {
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
	readonly receivedChunks: Array<AudioChunk> = [];
	closed = false;

	override async _write(chunk: AudioChunk): Promise<void> {
		this.receivedChunks.push(chunk);
	}

	override async _close(): Promise<void> {
		this.closed = true;
	}
}

class MockTarget extends TargetNode {
	static readonly packageName = "test";
	static readonly moduleName = "mock-target";
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

function createChunk(value: number, offset: number, duration: number): AudioChunk {
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
		// Regression: a bag node that sets only some parameters (e.g.
		// crestReduce with just `smoothing`) must instantiate with the
		// schema's `.default()`s applied — symmetric with `pack()` /
		// the convenience constructors. Before the fix `unpack` did
		// `new NodeClass(nodeDef.parameters)` raw, so an omitted defaulted
		// param stayed `undefined` (crestReduce: frameSize→hopSize→
		// frameCount NaN → `new Array(NaN)` RangeError on whole-file flush).
		class DefaultingTransformNode extends TransformNode {
			static readonly packageName = "test";
			static readonly moduleName = "defaulting-transform";
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
