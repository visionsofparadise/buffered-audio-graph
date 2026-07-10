import { describe, expect, it } from "vitest";
import {
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

function createChunk(value: number, offset: number, duration: number): Block {
	const samples = new Float32Array(duration).fill(value);

	return { samples: [samples], offset, sampleRate: 44100, bitDepth: 32 };
}

describe("chain() render", () => {
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
});
