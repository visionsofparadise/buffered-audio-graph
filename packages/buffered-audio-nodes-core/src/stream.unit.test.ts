import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Block } from "./block-buffer";
import type { BufferedAudioNode } from "./node";
import { BufferedSourceStream, SourceNode, type SourceMetadata } from "./source";
import { BufferedTargetStream, TargetNode } from "./target";
import { UnbufferedTransformStream } from "./unbuffered-transform";
import { TransformNode } from "./transform";
import { BufferedStream, type FinishedPayload, type LogPayload, type ProgressPayload, type RenderEvents, type StartedPayload, type StreamContext, type StreamIdentity, type StreamPhase, type StreamSetupContext } from "./stream";

function renderContext(): { context: StreamContext; events: RenderEvents } {
	const events: RenderEvents = new EventEmitter();
	let counter = 0;

	return { events, context: { events, nextStreamId: () => counter++ } };
}

function fakeNode(nodeName: string, id?: string): BufferedAudioNode {
	return { id, properties: { id }, constructor: { nodeName } } as unknown as BufferedAudioNode;
}

class ProbeStream extends BufferedStream {
	emitProgressPublic(phase: StreamPhase, framesDone: number, framesTotal?: number): void {
		this.emitProgress(phase, framesDone, framesTotal);
	}

	emitStartedPublic(): void {
		this.emitStarted();
	}

	emitFinishedPublic(payload: Omit<FinishedPayload, "createdAt">): void {
		this.emitFinished(payload);
	}

	logPublic(message: string, data?: Record<string, unknown>, level?: "info" | "warn"): void {
		this.log(message, data, level);
	}
}

function collectProgress(events: RenderEvents): Array<ProgressPayload> {
	const out: Array<ProgressPayload> = [];

	events.on("progress", (_identity, payload) => out.push(payload));

	return out;
}

describe("BufferedStream identity", () => {
	it("mints nodeName, nodeId, and an incrementing streamId per construction", () => {
		const { context } = renderContext();
		const a = new ProbeStream(fakeNode("gain", "id-a"), context);
		const b = new ProbeStream(fakeNode("gain"), context);

		expect(a.identity.nodeName).toBe("gain");
		expect(a.identity.nodeId).toBe("id-a");
		expect(a.identity.streamId).toBe(0);
		expect(b.identity.nodeId).toBeUndefined();
		expect(b.identity.streamId).toBe(1);
	});

	it("reads properties through to the live node", () => {
		const node = fakeNode("probe", "p");
		const stream = new ProbeStream(node, renderContext().context);

		expect(stream.properties).toBe(node.properties);
	});
});

describe("BufferedStream.emitProgress", () => {
	it("emits on every call, carrying phase, frames, and createdAt", () => {
		const { context, events } = renderContext();
		const stream = new ProbeStream(fakeNode("probe", "p"), context);
		const collected = collectProgress(events);

		stream.emitProgressPublic("read", 0, 100);
		stream.emitProgressPublic("read", 1, 100);
		stream.emitProgressPublic("read", 2, 100);

		expect(collected).toHaveLength(3);
		expect(collected[0]).toEqual({ phase: "read", framesDone: 0, framesTotal: 100, createdAt: expect.any(Number) });
		expect(collected.map((e) => e.framesDone)).toEqual([0, 1, 2]);
	});

	it("emits with an undefined total when none is given", () => {
		const { context, events } = renderContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const collected = collectProgress(events);

		stream.emitProgressPublic("emit", 5);

		expect(collected[0]).toEqual({ phase: "emit", framesDone: 5, framesTotal: undefined, createdAt: expect.any(Number) });
	});
});

describe("BufferedStream lifecycle emits", () => {
	it("emitStarted carries a payload stamped with createdAt", () => {
		const { context, events } = renderContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const payloads: Array<StartedPayload> = [];

		events.on("started", (_identity, payload) => payloads.push(payload));
		stream.emitStartedPublic();

		expect(payloads).toEqual([{ createdAt: expect.any(Number) }]);
	});

	it("emitFinished stamps createdAt onto the payload", () => {
		const { context, events } = renderContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const finished: Array<FinishedPayload> = [];

		events.on("finished", (_identity, payload) => finished.push(payload));
		stream.emitFinishedPublic({ framesDone: 42, processingMs: 5 });

		expect(finished[0]).toEqual({ framesDone: 42, processingMs: 5, createdAt: expect.any(Number) });
	});
});

describe("BufferedStream.log", () => {
	it("emits once with level, message, data, and createdAt", () => {
		const { context, events } = renderContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const logs: Array<LogPayload> = [];

		events.on("log", (_identity, payload) => logs.push(payload));
		stream.logPublic("m", { a: 1 }, "warn");

		expect(logs).toEqual([{ level: "warn", message: "m", data: { a: 1 }, createdAt: expect.any(Number) }]);
	});

	it("defaults to info", () => {
		const { context, events } = renderContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const logs: Array<LogPayload> = [];

		events.on("log", (_identity, payload) => logs.push(payload));
		stream.logPublic("hi");

		expect(logs[0]?.level).toBe("info");
	});
});

function block(value: number, offset: number, frames: number): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate: 44100, bitDepth: 32 };
}

class LifeSourceStream extends BufferedSourceStream {
	private index = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1, durationFrames: 200 };
	}

	override async _read(): Promise<Block | undefined> {
		const chunks = this.properties.chunks as Array<Block>;
		const chunk = chunks[this.index];

		if (!chunk) return undefined;
		this.index += 1;

		return chunk;
	}
}

class LifeSource extends SourceNode {
	static readonly packageName = "test";
	static readonly nodeName = "life-source";
	static override readonly schema = z.object({});
	static override readonly Stream = LifeSourceStream;

	constructor(chunks: Array<Block>) {
		super({ chunks } as never);
	}
}

class LifeTransformStream extends UnbufferedTransformStream {
	override *_transform(block: Block): Iterable<Block> {
		yield block;
	}
}

class LifeTransform extends TransformNode {
	static readonly packageName = "test";
	static readonly nodeName = "life-transform";
	static override readonly schema = z.object({});
	static override readonly Stream = LifeTransformStream;
}

class LifeTargetStream extends BufferedTargetStream {
	override async _write(): Promise<void> {}
	override async _close(): Promise<void> {}
}

class LifeTarget extends TargetNode {
	static readonly packageName = "test";
	static readonly nodeName = "life-target";
	static override readonly schema = z.object({});
	static override readonly Stream = LifeTargetStream;
}

describe("Lifecycle events end-to-end", () => {
	it("source emits started once and finished with framesDone; target finished with framesDone and createdAt", async () => {
		const source = new LifeSource([block(1, 0, 100), block(2, 100, 100)]);
		const target = new LifeTarget();

		source.to(target);

		const events: Array<{ identity: StreamIdentity; kind: string; framesDone?: number; processingMs?: number; createdAt?: number }> = [];
		const job = source.createRenderJob();

		job.events.on("started", (identity) => events.push({ identity, kind: "started" }));
		job.events.on("finished", (identity, payload) => events.push({ identity, kind: "finished", framesDone: payload.framesDone, processingMs: payload.processingMs, createdAt: payload.createdAt }));

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
		const source = new LifeSource([block(1, 0, 100)]);
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

function destroyContext(): StreamSetupContext {
	return { executionProviders: ["cpu"], memoryLimit: 256 * 1024 * 1024, highWaterMark: 16 };
}

async function drainReadable(readable: ReadableStream<Block>): Promise<void> {
	const reader = readable.getReader();

	for (;;) {
		const { done } = await reader.read();

		if (done) break;
	}
}

class CountingSourceStream extends BufferedSourceStream {
	destroyCount = 0;
	private index = 0;

	constructor(
		private readonly chunks: Array<Block>,
		private readonly throwAt?: number,
	) {
		super(fakeNode("counting-source"), renderContext().context);
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

class CountingTargetStream extends BufferedTargetStream {
	destroyCount = 0;

	constructor() {
		super(fakeNode("counting-target"), renderContext().context);
	}

	override async _write(): Promise<void> {}
	override async _close(): Promise<void> {}

	override _destroy(): void {
		this.destroyCount += 1;
	}
}

describe("BufferedStream.destroy idempotency", () => {
	it("runs _destroy exactly once across repeated destroy() calls", async () => {
		const stream = new CountingSourceStream([block(1, 0, 10)]);

		await stream.destroy();
		await stream.destroy();
		await stream.destroy();

		expect(stream.destroyCount).toBe(1);
	});
});

describe("source stream-scoped destroy", () => {
	it("graceful end-of-read invokes destroy once", async () => {
		const stream = new CountingSourceStream([block(1, 0, 100), block(2, 100, 100)]);

		await drainReadable(await stream._setup(destroyContext()));

		expect(stream.destroyCount).toBe(1);
	});

	it("read error invokes destroy once and surfaces the error", async () => {
		const stream = new CountingSourceStream([block(1, 0, 100)], 0);

		await expect(drainReadable(await stream._setup(destroyContext()))).rejects.toThrow("read boom");
		expect(stream.destroyCount).toBe(1);
	});

	it("consumer cancel invokes destroy once", async () => {
		const stream = new CountingSourceStream([block(1, 0, 100), block(2, 100, 100)]);
		const reader = (await stream._setup(destroyContext())).getReader();

		await reader.read();
		await reader.cancel("stop");

		expect(stream.destroyCount).toBe(1);
	});
});

function readableOf(chunks: Array<Block>): ReadableStream<Block> {
	let index = 0;

	return new ReadableStream<Block>({
		pull(controller) {
			const value = chunks[index];

			if (value) {
				index += 1;
				controller.enqueue(value);
			} else {
				controller.close();
			}
		},
	});
}

describe("target stream-scoped destroy", () => {
	it("graceful close invokes destroy once", async () => {
		const target = new CountingTargetStream();

		await target._setup(readableOf([block(1, 0, 100), block(2, 100, 100)]), destroyContext());

		expect(target.destroyCount).toBe(1);
	});

	it("upstream error aborts the sink and invokes destroy once", async () => {
		const target = new CountingTargetStream();
		const erroring = new ReadableStream<Block>({
			pull(controller) {
				controller.error(new Error("upstream boom"));
			},
		});

		await expect(target._setup(erroring, destroyContext())).rejects.toThrow("upstream boom");
		expect(target.destroyCount).toBe(1);
	});
});
