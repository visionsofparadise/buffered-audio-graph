import { describe, expect, it } from "vitest";
import {
	type BufferedAudioNode,
	BufferedSourceStream,
	BufferedTargetStream,
	UnbufferedTransformStream,
	SourceNode,
	TargetNode,
	TransformNode,
	type Block,
	type SourceMetadata,
} from "@buffered-audio/core";
import { chain } from "./chain";

class MockSourceStream extends BufferedSourceStream {
	private index = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return this.properties.meta as SourceMetadata;
	}

	override async _read(): Promise<Block | undefined> {
		const chunks = this.properties.chunks as Array<Block>;
		const chunk = chunks[this.index];

		if (chunk) {
			this.index += 1;

			return chunk;
		}

		return undefined;
	}
}

class MockSource extends SourceNode {
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
	// eslint-disable-next-line @typescript-eslint/require-await
	override async transform(block: Block, enqueue: (block: Block) => void): Promise<void> {
		enqueue(block);
	}
}

class MockTransform extends TransformNode {
	static override readonly streamClass = MockTransformStream;
	readonly type = ["buffered-audio-node", "transform", "mock"] as const;

	clone(): MockTransform {
		return new MockTransform();
	}
}

class MockTargetStream extends BufferedTargetStream {
	readonly receivedChunks: Array<Block> = [];
	closed = false;

	// eslint-disable-next-line @typescript-eslint/require-await
	override async _write(chunk: Block): Promise<void> {
		this.receivedChunks.push(chunk);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	override async _close(): Promise<void> {
		this.closed = true;
	}
}

class MockTarget extends TargetNode {
	static override readonly streamClass = MockTargetStream;
	readonly type = ["buffered-audio-node", "target", "mock"] as const;

	clone(): MockTarget {
		return new MockTarget();
	}
}

function createChunk(value: number, offset: number, duration: number): Block {
	const samples = new Float32Array(duration).fill(value);

	return { samples: [samples], offset, sampleRate: 44100, bitDepth: 32 };
}

describe("chain()", () => {
	it("chain(source, target) — head is source, tail is target", () => {
		const source = new MockSource();
		const target = new MockTarget();

		const c = chain(source, target);

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

	it("wires each junction: source → transform → target", () => {
		const source = new MockSource();
		const transform = new MockTransform();
		const target = new MockTarget();

		chain(source, transform, target);

		expect(source.children).toContain(transform as BufferedAudioNode);
		expect(transform.children).toContain(target as BufferedAudioNode);
	});

	it(".to() delegation: chain(a, b).to(c) connects b to c", () => {
		const source = new MockSource();
		const transform = new MockTransform();
		const target = new MockTarget();

		const c = chain(source, transform);
		c.to(target);

		expect(transform.children).toContain(target as BufferedAudioNode);
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

		expect(source.children).toContain(t1 as BufferedAudioNode);
		expect(t1.children).toContain(t2 as BufferedAudioNode);
		expect(t2.children).toContain(target as BufferedAudioNode);
	});

	it("renders via createRenderJob when the head is a source", async () => {
		const chunks = [createChunk(1.0, 0, 100)];
		const source = new MockSource(chunks, { sampleRate: 44100, channels: 1, durationFrames: 100 });
		const transform = new MockTransform();
		const target = new MockTarget();

		const c = chain(source, transform, target);
		const job = source.createRenderJob();

		await job.render();

		const targetStream = job.streams.get(c.tail)?.[0];

		if (!(targetStream instanceof MockTargetStream)) throw new Error("expected a MockTargetStream for the tail node");

		expect(targetStream.receivedChunks).toHaveLength(1);
		expect(targetStream.closed).toBe(true);
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

		expect(() => c.to(target2)).toThrow("Cannot connect downstream from a TargetNode");
	});
});
