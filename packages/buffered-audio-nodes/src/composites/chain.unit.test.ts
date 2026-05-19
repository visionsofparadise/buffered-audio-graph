import { describe, expect, it } from "vitest";
import type { ChunkBuffer } from "@buffered-audio/core";
import { BufferedSourceStream, SourceNode, type AudioChunk, type SourceMetadata } from "@buffered-audio/core";
import { BufferedTransformStream, TransformNode } from "@buffered-audio/core";
import { BufferedTargetStream, TargetNode } from "@buffered-audio/core";
import { chain, ChainNode } from "./chain";

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
	readonly type = ["buffered-audio-node", "source", "mock"] as const;

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
	readonly type = ["buffered-audio-node", "target", "mock"] as const;

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

describe("chain()", () => {
	it("chain(source, target) — head is source, tail is target", () => {
		const source = new MockSource();
		const target = new MockTarget();

		const c = chain(source, target);

		expect(c).toBeInstanceOf(ChainNode);
		expect(c.head).toBe(source);
		expect(c.tail).toBe(target);
	});

	it("chain(source, transform, target) — head is source, tail is target", () => {
		const source = new MockSource();
		const transform = new MockTransform();
		const target = new MockTarget();

		const c = chain(source, transform, target);

		expect(c.head).toBe(source);
		expect(c.tail).toBe(target);
	});

	it("chain(transform, transform) — head is first, tail is second", () => {
		const t1 = new MockTransform();
		const t2 = new MockTransform();

		const c = chain(t1, t2);

		expect(c.head).toBe(t1);
		expect(c.tail).toBe(t2);
	});

	it(".to() delegation: chain(a, b).to(c) connects b to c", () => {
		const source = new MockSource();
		const transform = new MockTransform();
		const target = new MockTarget();

		const c = chain(source, transform);
		c.to(target);

		expect(transform.children).toContain(target);
	});

	it("nested chains: chain(source, chain(t1, t2), target)", () => {
		const source = new MockSource();
		const t1 = new MockTransform();
		const t2 = new MockTransform();
		const target = new MockTarget();

		const inner = chain(t1, t2);
		const outer = chain(source, inner, target);

		expect(outer.head).toBe(source);
		expect(outer.tail).toBe(target);

		// source → t1 (via source.children)
		expect(source.children).toContain(t1);
		// t2 → target (via t2.children)
		expect(t2.children).toContain(target);
	});

	it("render() delegation: chain(source, transform, target).render() flows chunks", async () => {
		const chunks = [createChunk(1.0, 0, 100)];
		const source = new MockSource(chunks, { sampleRate: 44100, channels: 1 });
		const transform = new MockTransform();
		const target = new MockTarget();

		const c = chain(source, transform, target);
		await c.render();

		expect(transform.processedChunks).toHaveLength(1);
		expect(target.lastCreatedStream?.receivedChunks).toHaveLength(1);
		expect(target.lastCreatedStream?.closed).toBe(true);
	});

	it("fan-out from chain: c.to(target1); c.to(target2)", async () => {
		const chunks = [createChunk(0.5, 0, 100)];
		const source = new MockSource(chunks, { sampleRate: 44100, channels: 1 });
		const transform = new MockTransform();
		const target1 = new MockTarget();
		const target2 = new MockTarget();

		const c = chain(source, transform);
		c.to(target1);
		c.to(target2);
		await c.render();

		expect(target1.lastCreatedStream?.receivedChunks).toHaveLength(1);
		expect(target2.lastCreatedStream?.receivedChunks).toHaveLength(1);
	});

	it("throws with fewer than 2 arguments", () => {
		const source = new MockSource();

		expect(() => chain(source)).toThrow("chain() requires at least 2 nodes");
		expect(() => chain()).toThrow("chain() requires at least 2 nodes");
	});

	it("throws when mid-chain node is a TargetNode", () => {
		const source = new MockSource();
		const target = new MockTarget();
		const target2 = new MockTarget();

		expect(() => chain(source, target, target2)).toThrow("Cannot connect downstream from a TargetNode");
	});

	it("throws on .to() when chain tail is a TargetNode", () => {
		const source = new MockSource();
		const target = new MockTarget();
		const target2 = new MockTarget();

		const c = chain(source, target);

		expect(() => c.to(target2)).toThrow("Cannot connect downstream from a target node; this composite is a complete pipeline");
	});

	it("throws on setup() when chain head is a SourceNode", async () => {
		const source = new MockSource();
		const transform = new MockTransform();

		const c = chain(source, transform);

		const fakeReadable = new ReadableStream<AudioChunk>();
		const fakeContext = {
			executionProviders: ["cpu"] as const,
			memoryLimit: 256 * 1024 * 1024,
			highWaterMark: 1,
			visited: new Set(),
		};

		await expect(c.setup(fakeReadable, fakeContext)).rejects.toThrow("Cannot setup a composite whose head is a source node; use render() for complete pipelines");
	});

	it("throws on render() when chain head is not a SourceNode", async () => {
		const t1 = new MockTransform();
		const t2 = new MockTransform();

		const c = chain(t1, t2);

		await expect(c.render()).rejects.toThrow("Cannot render a composite whose head is not a source node");
	});
});
