import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StreamIdentity } from ".";
import type { BufferedAudioNode } from "..";
import type { Block } from "./block";
import { BufferedSourceStream, type SourceMetadata, type SourceNodeProperties } from "./source";
import { SourceNode } from "../source";
import { BufferedTargetStream, TargetNode } from "./target";
import { UnbufferedTransformStream } from "./transform/unbuffered-transform";
import { TransformNode } from "../transform";
import { createBlock } from "../../testing/blocks";
import { createTestSetupContext, createTestStreamContext } from "../../testing/contexts";
import { drainBlocks, readableFrom } from "../../testing/streams";

function fakeNode(nodeName: string, id?: string): BufferedAudioNode {
	return { id, properties: { id }, constructor: { nodeName } } as unknown as BufferedAudioNode;
}

interface LifeSourceProperties extends SourceNodeProperties {
	readonly chunks: Array<Block>;
}

class LifeSourceStream extends BufferedSourceStream<LifeSource> {
	private index = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1, durationFrames: 200 };
	}

	override async _read(): Promise<Block | undefined> {
		const chunks = this.properties.chunks;
		const chunk = chunks[this.index];

		if (!chunk) return undefined;
		this.index += 1;

		return chunk;
	}
}

class LifeSource extends SourceNode<LifeSourceProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "life-source";
	static override readonly schema = z.object({});
	static override readonly Stream = LifeSourceStream;

	constructor(chunks: Array<Block>) {
		super({ chunks });
	}
}

class LifeTransformStream extends UnbufferedTransformStream {
	override *_transform(block: Block): Iterable<Block> {
		yield block;
	}
}

class LifeTransform extends TransformNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "life-transform";
	static override readonly schema = z.object({});
	static override readonly Stream = LifeTransformStream;
}

class LifeTargetStream extends BufferedTargetStream {
	override async _write(): Promise<void> {}
	override async _close(): Promise<void> {}
}

class LifeTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "life-target";
	static override readonly schema = z.object({});
	static override readonly Stream = LifeTargetStream;
}

describe("Lifecycle events end-to-end", () => {
	it("source emits started once and finished with framesDone; target finished with framesDone and createdAt", async () => {
		const source = new LifeSource([createBlock(1, 0, 100), createBlock(2, 100, 100)]);
		const target = new LifeTarget();

		source.to(target);

		const events: Array<{
			identity: StreamIdentity;
			kind: string;
			framesDone?: number;
			processingMs?: number;
			createdAt?: number;
		}> = [];
		const job = source.createRenderJob();

		job.events.on("started", (identity) => events.push({ identity, kind: "started" }));
		job.events.on("finished", (identity, payload) =>
			events.push({
				identity,
				kind: "finished",
				framesDone: payload.framesDone,
				processingMs: payload.processingMs,
				createdAt: payload.createdAt,
			}),
		);

		await job.render();

		const sourceStarted = events.filter((e) => e.identity.nodeName === "life-source" && e.kind === "started");
		const sourceFinished = events.find((e) => e.identity.nodeName === "life-source" && e.kind === "finished");
		const targetFinished = events.find((e) => e.identity.nodeName === "life-target" && e.kind === "finished");

		expect(sourceStarted).toHaveLength(1);
		expect(sourceFinished?.framesDone).toBe(200);
		expect(targetFinished?.framesDone).toBe(200);
		expect(sourceFinished?.createdAt).toBeTypeOf("number");
		expect(targetFinished?.createdAt).toBeTypeOf("number");
		expect(Number.isFinite(sourceFinished?.processingMs)).toBe(true);
		expect(Number.isFinite(targetFinished?.processingMs)).toBe(true);
	});

	it("delivers events for all three nodes with correct identity and unique streamIds", async () => {
		const source = new LifeSource([createBlock(1, 0, 100)]);
		const transform = new LifeTransform();
		const target = new LifeTarget();

		source.to(transform);
		transform.to(target);

		const names = new Set<string>();
		const streamIds = new Set<number>();
		const job = source.createRenderJob();

		const record = (identity: StreamIdentity): void => {
			names.add(identity.nodeName);
			streamIds.add(identity.streamId);
		};

		job.events.on("started", record);
		job.events.on("progress", record);
		job.events.on("finished", record);

		await job.render();

		expect(names).toEqual(new Set(["life-source", "life-transform", "life-target"]));
		expect(streamIds).toEqual(new Set([0, 1, 2]));
	});
});

class CountingSourceStream extends BufferedSourceStream {
	destroyCount = 0;
	private index = 0;

	constructor(
		private readonly chunks: Array<Block>,
		private readonly throwAt?: number,
	) {
		super(fakeNode("counting-source"), createTestStreamContext().context);
	}

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1, durationFrames: 200 };
	}

	override async _read(): Promise<Block | undefined> {
		if (this.throwAt !== undefined && this.index === this.throwAt) throw new Error("read boom");

		const chunk = this.chunks[this.index];

		if (!chunk) return undefined;
		this.index += 1;

		return chunk;
	}

	override _destroy(): void {
		this.destroyCount += 1;
	}
}

async function drainReader(reader: ReadableStreamDefaultReader<Block>): Promise<void> {
	for (;;) {
		const { done } = await reader.read();

		if (done) return;
	}
}

class CountingTargetStream extends BufferedTargetStream {
	destroyCount = 0;

	constructor() {
		super(fakeNode("counting-target"), createTestStreamContext().context);
	}

	override async _write(): Promise<void> {}
	override async _close(): Promise<void> {}

	override _destroy(): void {
		this.destroyCount += 1;
	}
}

describe("BufferedStream.destroy idempotency", () => {
	it("runs _destroy exactly once across repeated destroy() calls", async () => {
		const stream = new CountingSourceStream([createBlock(1, 0, 10)]);

		await stream.destroy();
		await stream.destroy();
		await stream.destroy();

		expect(stream.destroyCount).toBe(1);
	});
});

describe("source stream-scoped destroy", () => {
	it("graceful end-of-read invokes destroy once", async () => {
		const stream = new CountingSourceStream([createBlock(1, 0, 100), createBlock(2, 100, 100)]);

		await drainBlocks(await stream._setup(createTestSetupContext()));

		expect(stream.destroyCount).toBe(1);
	});

	it("read error invokes destroy once and surfaces the error", async () => {
		const stream = new CountingSourceStream([createBlock(1, 0, 100)], 0);

		await expect(drainBlocks(await stream._setup(createTestSetupContext()))).rejects.toThrow("read boom");
		expect(stream.destroyCount).toBe(1);
	});

	it("a render abort errors the output with the signal's reason instead of ending it", async () => {
		const stream = new CountingSourceStream([createBlock(1, 0, 100), createBlock(2, 100, 100)]);
		const controller = new AbortController();
		const reader = (
			await stream._setup(createTestSetupContext({ highWaterMark: 1, signal: controller.signal }))
		).getReader();

		await reader.read();
		controller.abort(new Error("render failed"));

		await expect(drainReader(reader)).rejects.toThrow("render failed");
		expect(stream.destroyCount).toBe(1);
	});

	it("returns a rejected promise from setup() once destroyed", async () => {
		const stream = new CountingSourceStream([createBlock(1, 0, 100)]);

		await stream.destroy();

		let setup: Promise<unknown> | undefined;

		expect(() => {
			setup = stream.setup(createTestSetupContext());
		}).not.toThrow();
		await expect(setup).rejects.toMatchObject({ name: "AbortError" });
	});

	it("consumer cancel invokes destroy once", async () => {
		const stream = new CountingSourceStream([createBlock(1, 0, 100), createBlock(2, 100, 100)]);
		const reader = (await stream._setup(createTestSetupContext())).getReader();

		await reader.read();
		await reader.cancel("stop");

		expect(stream.destroyCount).toBe(1);
	});
});

class FinallyThrowingTransformStream extends UnbufferedTransformStream {
	constructor() {
		super(fakeNode("finally-throwing-transform"), createTestStreamContext().context);
	}

	override async *_transform(block: Block): AsyncGenerator<Block> {
		try {
			yield block;
		} finally {
			if (this.streamSignal.aborted) throw new Error("finally failed");
		}
	}

	override _destroy(): void {
		throw new Error("destroy failed");
	}
}

describe("transform teardown errors", () => {
	it("rejects destroy() with the pipeline unwind error and the _destroy error, unwind error first", async () => {
		const stream = new FinallyThrowingTransformStream();
		const input = new ReadableStream<Block>({
			pull(controller) {
				controller.enqueue(createBlock(1, 0, 100));
			},
		});
		const reader = (await stream.setup(input, createTestSetupContext({ highWaterMark: 1 }))).getReader();

		await reader.read();
		await new Promise((resolve) => setTimeout(resolve, 10));

		const error = await stream.destroy().then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).message).toBe("Stream teardown failed");
		expect((error as AggregateError).errors.map((entry: Error) => entry.message)).toEqual([
			"finally failed",
			"destroy failed",
		]);
	});
});

describe("target stream-scoped destroy", () => {
	it("graceful close invokes destroy once", async () => {
		const target = new CountingTargetStream();

		await target._setup(readableFrom([createBlock(1, 0, 100), createBlock(2, 100, 100)]), createTestSetupContext());

		expect(target.destroyCount).toBe(1);
	});

	it("upstream error aborts the sink and invokes destroy once", async () => {
		const target = new CountingTargetStream();
		const erroring = new ReadableStream<Block>({
			pull(controller) {
				controller.error(new Error("upstream boom"));
			},
		});

		await expect(target._setup(erroring, createTestSetupContext())).rejects.toThrow("upstream boom");
		expect(target.destroyCount).toBe(1);
	});
});
