import { describe, expect, it } from "vitest";
import type { BlockBuffer } from "./block-buffer";
import type { Block } from "./node";
import type { SourceMetadata } from "./source";
import { BufferedAudioNode } from "./node";
import { BufferedSourceStream, SourceNode } from "./source";
import { BufferedStream } from "./stream";
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
}

class MockSource extends SourceNode {
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

class FailingTargetStream extends BufferedTargetStream {
	override async _write(): Promise<void> {
		throw new Error("write failed");
	}

	override async _close(): Promise<void> {}
}

class FailingTarget extends TargetNode {
	readonly type = ["buffered-audio-node", "target", "failing"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }
	override createStream(): FailingTargetStream {
		return new FailingTargetStream(this.properties as unknown as Record<string, unknown>);
	}
	clone(): FailingTarget {
		return new FailingTarget();
	}
}

function createChunk(value: number, offset: number, duration: number): Block {
	const samples = new Float32Array(duration).fill(value);
	return { samples: [samples], offset, sampleRate: 44100, bitDepth: 32 };
}

const testMeta: SourceMetadata = { sampleRate: 44100, channels: 1 };

describe("BufferedAudioNode", () => {
	it("type discrimination with is()", () => {
		const source = new MockSource();
		const transform = new MockTransform();
		const target = new MockTarget();

		expect(BufferedAudioNode.is(source)).toBe(true);
		expect(BufferedAudioNode.is(transform)).toBe(true);
		expect(BufferedAudioNode.is(target)).toBe(true);
		expect(BufferedAudioNode.is({})).toBe(false);
		expect(BufferedAudioNode.is(null)).toBe(false);

		expect(SourceNode.is(source)).toBe(true);
		expect(SourceNode.is(transform)).toBe(false);

		expect(TransformNode.is(transform)).toBe(true);
		expect(TransformNode.is(source)).toBe(false);

		expect(TargetNode.is(target)).toBe(true);
		expect(TargetNode.is(source)).toBe(false);
	});

	it("to() appends child", () => {
		const source = new MockSource();
		const target = new MockTarget();

		source.to(target);
		expect(source.children).toContain(target);
	});

	it("teardown() iterates streams and recurses to children", async () => {
		const source = new MockSource();
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);

		let tornDown = false;

		class TeardownStream extends BufferedStream {
			override _destroy(): void {
				tornDown = true;
			}
		}

		source.streams.push(new TeardownStream({} as never));

		await source.teardown();

		expect(tornDown).toBe(true);
	});

	it("teardown() clears streams on node and children", async () => {
		const source = new MockSource();
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);

		class NoopStream extends BufferedStream {}

		source.streams.push(new NoopStream({} as never));
		transform.streams.push(new NoopStream({} as never));

		await source.teardown();

		expect(source.streams).toHaveLength(0);
		expect(transform.streams).toHaveLength(0);
	});

	it("abstract bufferSize and latency must be implemented", () => {
		const source = new MockSource();
		expect(source.bufferSize).toBe(0);
		expect(source.latency).toBe(0);
	});
});

describe("SourceNode render", () => {
	it("source → target pipeline flows chunks", async () => {
		const chunks = [createChunk(1.0, 0, 100), createChunk(0.5, 100, 100)];
		const source = new MockSource(chunks, testMeta);
		const target = new MockTarget();

		source.to(target);
		await source.render();

		expect(target.lastCreatedStream?.receivedChunks).toHaveLength(2);
		expect(target.lastCreatedStream?.receivedChunks[0]?.samples[0]?.[0]).toBe(1.0);
		expect(target.lastCreatedStream?.receivedChunks[1]?.samples[0]?.[0]).toBe(0.5);
		expect(target.lastCreatedStream?.closed).toBe(true);
	});

	it("source → transform → target pipeline flows chunks", async () => {
		const chunks = [createChunk(1.0, 0, 100)];
		const source = new MockSource(chunks, testMeta);
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);
		await source.render();

		expect(transform.processedChunks).toHaveLength(1);
		expect(target.lastCreatedStream?.receivedChunks).toHaveLength(1);
		expect(target.lastCreatedStream?.closed).toBe(true);
	});

	it("teardown runs on error", async () => {
		const source = new MockSource([createChunk(1.0, 0, 100)], testMeta);
		const target = new FailingTarget();

		source.to(target);

		await expect(source.render()).rejects.toThrow("write failed");
	});
});
