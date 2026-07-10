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
	static override readonly Stream = MockSourceStream;

	constructor(chunks: Array<Block> = [], meta: SourceMetadata = { sampleRate: 44100, channels: 1 }) {
		super({ chunks, meta } as never);
	}
}

class MockTransformStream extends UnbufferedTransformStream {
	override *_transform(block: Block): Generator<Block> {
		yield block;
	}
}

class MockTransform extends TransformNode {
	static override readonly Stream = MockTransformStream;
}

class MockTargetStream extends BufferedTargetStream {
	readonly receivedChunks: Array<Block> = [];
	closed = false;

	override _write(chunk: Block): void {
		this.receivedChunks.push(chunk);
	}

	override _close(): void {
		this.closed = true;
	}
}

class MockTarget extends TargetNode {
	static override readonly Stream = MockTargetStream;
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
