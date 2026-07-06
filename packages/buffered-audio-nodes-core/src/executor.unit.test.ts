import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRenderJobs, pack, substituteParameters, unpack, validateGraphDefinition, type GraphDefinition, type NodeRegistry } from "./graph-format";
import type { Block, BufferedAudioNode } from "./node";
import { RenderJob } from "./render-job";
import { BufferedSourceStream, SourceNode, type SourceMetadata } from "./source";
import { BufferedTargetStream, TargetNode } from "./target";
import { UnbufferedTransformStream } from "./unbuffered-transform";
import { TransformNode } from "./transform";

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
	static override readonly streamClass = MockSourceStream;

	readonly type = ["buffered-audio-node", "source", "mock"] as const;

	constructor(chunks: Array<Block> = [], meta: SourceMetadata = { sampleRate: 44100, channels: 1 }) {
		super({ chunks, meta } as never);
	}

	clone(): MockSource {
		return new MockSource();
	}
}

class MockTransformStream extends UnbufferedTransformStream {
	override transform(block: Block, enqueue: (block: Block) => void): void {
		enqueue(block);
	}
}

class MockTransform extends TransformNode {
	static readonly packageName = "test";
	static readonly nodeName = "mock-transform";
	static override readonly schema = z.object({});
	static override readonly streamClass = MockTransformStream;

	readonly type = ["buffered-audio-node", "transform", "mock"] as const;

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
	static override readonly streamClass = MockTargetStream;

	readonly type = ["buffered-audio-node", "target", "mock"] as const;

	clone(): MockTarget {
		return new MockTarget();
	}
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
	static override readonly streamClass = FailingTargetStream;

	readonly type = ["buffered-audio-node", "target", "failing"] as const;

	clone(): FailingTarget {
		return new FailingTarget();
	}
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

describe("graph definition validation", () => {
	it("validates a graph definition", () => {
		const valid = validateGraphDefinition({
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			name: "Test",
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
			nodes: [{ id: "a", packageName: "@buffered-audio/nodes", packageVersion: "1.0.0", nodeName: "read" }],
			edges: [],
		});

		expect(valid.name).toBe("Untitled");
	});

	it("rejects an invalid id", () => {
		expect(() =>
			validateGraphDefinition({
				id: "not-a-uuid",
				nodes: [{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read" }],
				edges: [],
			}),
		).toThrow();
	});
});

describe("pack id round-trip", () => {
	it("pack preserves a provided id", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

		expect(pack([source], { name: "Test", id }).id).toBe(id);
	});

	it("pack generates an id when absent", () => {
		const source = new MockSource();
		const target = new MockTarget();
		source.to(target);

		expect(pack([source], { name: "Test" }).id).toMatch(/^[0-9a-f-]{36}$/);
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
			static override readonly streamClass = MockTransformStream;

			readonly type = ["buffered-audio-node", "transform", "mock"] as const;

			clone(): DefaultingTransform {
				return new DefaultingTransform();
			}
		}

		const registry: NodeRegistry = new Map([
			[
				"test",
				new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
					["mock-source", MockSource as never],
					["defaulting-transform", DefaultingTransform as never],
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
		const source = sources[0];
		const transform = source?.properties.children?.[0] as DefaultingTransform | undefined;

		expect(transform?.id).toBe("t");
		expect(transform?.properties.frameSize).toBe(2048);
		expect(transform?.properties.smoothing).toBe(30);
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
		expect(parameters.count).toBe(5);
	});

	it("does not mutate the input definition", () => {
		const definition = templatedDefinition([
			{ id: "a", packageName: "test", packageVersion: "1.0.0", nodeName: "read", parameters: { path: "{{episode}}/in.wav" } },
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
	static override readonly streamClass = PathSourceStream;

	readonly type = ["buffered-audio-node", "source", "mock"] as const;

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
	static override readonly streamClass = PathTargetStream;

	readonly type = ["buffered-audio-node", "target", "mock"] as const;

	clone(): PathTarget {
		return new PathTarget(this.properties);
	}
}

describe("createRenderJobs parameter substitution", () => {
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

		for (const job of createRenderJobs(definition, registry, { parameters: { dir: "e260" } })) await job.render();
		for (const job of createRenderJobs(definition, registry, { parameters: { dir: "e261" } })) await job.render();

		expect(capturedPaths).toEqual(["e260/out.wav", "e261/out.wav"]);
	});

	it("throws before any job is created when a required parameter is missing", () => {
		expect(() => createRenderJobs(definition, registry, { parameters: {} })).toThrow(/unbound placeholders: dir/);
	});
});
