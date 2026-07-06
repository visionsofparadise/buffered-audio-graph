import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Block, BufferedAudioNode, NodeIdentity } from "./node";
import { BufferedSourceStream, SourceNode, type SourceMetadata } from "./source";
import { BufferedTargetStream, TargetNode } from "./target";
import { UnbufferedTransformStream } from "./unbuffered-transform";
import { TransformNode } from "./transform";
import { BufferedStream, UNKNOWN_TOTAL_QUANTUM_FRAMES, type LogPayload, type ProgressPayload, type RenderEvents, type StreamPhase } from "./stream";

const IDENTITY: NodeIdentity = { nodeName: "probe", id: "p", type: ["buffered-audio-node", "probe"] };

class ProbeStream extends BufferedStream {
	emit(phase: StreamPhase, framesDone: number, framesTotal?: number, options?: { force?: boolean }): void {
		this.emitProgress(phase, framesDone, framesTotal, options);
	}

	callProgress(framesDone: number, framesTotal?: number): void {
		this.progress(framesDone, framesTotal);
	}

	callLog(message: string, data?: Record<string, unknown>, level?: "info" | "warn"): void {
		this.log(message, data, level);
	}
}

function probe(quantumFraction = 0.1): { stream: ProbeStream; events: RenderEvents } {
	const events: RenderEvents = new EventEmitter();
	const stream = new ProbeStream({ properties: {} } as unknown as BufferedAudioNode);

	stream.bind(events, IDENTITY, quantumFraction);

	return { stream, events };
}

function collectProgress(events: RenderEvents): Array<ProgressPayload> {
	const out: Array<ProgressPayload> = [];

	events.on("progress", (_identity, payload) => out.push(payload));

	return out;
}

describe("BufferedStream.emitProgress throttle", () => {
	it("known total: emits at 0, each quantum-boundary crossing, and forced final — not every increment", () => {
		const { stream, events } = probe();
		const collected = collectProgress(events);
		const total = 1000;

		for (let done = 0; done <= total; done += 10) {
			stream.emit("read", done, total, done === total ? { force: true } : undefined);
		}

		const framesDone = collected.map((e) => e.framesDone);

		expect(framesDone[0]).toBe(0);
		expect(framesDone.at(-1)).toBe(1000);
		expect(collected.length).toBeGreaterThanOrEqual(10);
		expect(collected.length).toBeLessThanOrEqual(13);
	});

	it("unknown total: boundaries at UNKNOWN_TOTAL_QUANTUM_FRAMES multiples", () => {
		const { stream, events } = probe();
		const collected = collectProgress(events);
		const step = UNKNOWN_TOTAL_QUANTUM_FRAMES / 4;

		for (let i = 0; i <= 8; i++) stream.emit("emit", i * step);

		expect(collected.map((e) => e.framesDone)).toEqual([0, UNKNOWN_TOTAL_QUANTUM_FRAMES, UNKNOWN_TOTAL_QUANTUM_FRAMES * 2]);
	});

	it("quantumFraction is honored", () => {
		const { stream, events } = probe(0.25);
		const collected = collectProgress(events);

		for (let done = 0; done <= 100; done += 5) stream.emit("read", done, 100);

		expect(collected.map((e) => e.framesDone)).toEqual([0, 25, 50, 75, 100]);
	});

	it("force always emits regardless of boundary", () => {
		const { stream, events } = probe();
		const collected = collectProgress(events);

		stream.emit("write", 0, 1000);
		stream.emit("write", 5, 1000, { force: true });
		stream.emit("write", 7, 1000, { force: true });

		expect(collected.map((e) => e.framesDone)).toEqual([0, 5, 7]);
	});

	it("emits nothing when unbound", () => {
		const stream = new ProbeStream({ properties: {} } as unknown as BufferedAudioNode);

		expect(() => stream.emit("read", 0, 100)).not.toThrow();
	});
});

describe("BufferedStream per-phase independence", () => {
	it("interleaved phases do not suppress each other's boundaries", () => {
		const { stream, events } = probe();
		const collected = collectProgress(events);

		stream.emit("buffer", 0, 1000);
		stream.emit("process", 0, 1000);
		stream.emit("buffer", 100, 1000);
		stream.emit("process", 100, 1000);
		stream.emit("buffer", 200, 1000);

		const byPhase = (phase: StreamPhase): Array<number> => collected.filter((e) => e.phase === phase).map((e) => e.framesDone);

		expect(byPhase("buffer")).toEqual([0, 100, 200]);
		expect(byPhase("process")).toEqual([0, 100]);
	});
});

describe("BufferedStream helpers", () => {
	it("progress() routes through the process phase throttle", () => {
		const { stream, events } = probe();
		const collected = collectProgress(events);

		for (let i = 0; i <= 1000; i++) stream.callProgress(i, 1000);

		expect(collected.every((e) => e.phase === "process")).toBe(true);
		expect(collected.length).toBeLessThan(20);
		expect(collected[0]?.framesDone).toBe(0);
	});

	it("log() emits once with exact payload and level", () => {
		const { stream, events } = probe();
		const logs: Array<LogPayload> = [];

		events.on("log", (_identity, payload) => logs.push(payload));
		stream.callLog("m", { a: 1 }, "warn");

		expect(logs).toEqual([{ level: "warn", message: "m", data: { a: 1 } }]);
	});

	it("log() defaults to info", () => {
		const { stream, events } = probe();
		const logs: Array<LogPayload> = [];

		events.on("log", (_identity, payload) => logs.push(payload));
		stream.callLog("hi");

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
	static override readonly streamClass = LifeSourceStream;

	readonly type = ["buffered-audio-node", "source", "life"] as const;

	constructor(chunks: Array<Block>) {
		super({ chunks } as never);
	}

	clone(): LifeSource {
		return new LifeSource(this.properties.chunks as Array<Block>);
	}
}

class LifeTransformStream extends UnbufferedTransformStream {
	override transform(block: Block, enqueue: (block: Block) => void): void {
		enqueue(block);
	}
}

class LifeTransform extends TransformNode {
	static readonly packageName = "test";
	static readonly nodeName = "life-transform";
	static override readonly schema = z.object({});
	static override readonly streamClass = LifeTransformStream;

	readonly type = ["buffered-audio-node", "transform", "life"] as const;

	clone(): LifeTransform {
		return new LifeTransform();
	}
}

class LifeTargetStream extends BufferedTargetStream {
	override async _write(): Promise<void> {}
	override async _close(): Promise<void> {}
}

class LifeTarget extends TargetNode {
	static readonly packageName = "test";
	static readonly nodeName = "life-target";
	static override readonly schema = z.object({});
	static override readonly streamClass = LifeTargetStream;

	readonly type = ["buffered-audio-node", "target", "life"] as const;

	clone(): LifeTarget {
		return new LifeTarget();
	}
}

describe("Lifecycle events end-to-end", () => {
	it("source emits started once and finished with framesDone; target finished with framesDone", async () => {
		const source = new LifeSource([block(1, 0, 100), block(2, 100, 100)]);
		const target = new LifeTarget();

		source.to(target);

		const events: Array<{ identity: NodeIdentity; kind: string; framesDone?: number }> = [];
		const job = source.createRenderJob();

		job.events.on("started", (identity) => events.push({ identity, kind: "started" }));
		job.events.on("finished", (identity, payload) => events.push({ identity, kind: "finished", framesDone: payload.framesDone }));

		await job.render();

		const sourceStarted = events.filter((e) => e.identity.nodeName === "life-source" && e.kind === "started");
		const sourceFinished = events.find((e) => e.identity.nodeName === "life-source" && e.kind === "finished");
		const targetFinished = events.find((e) => e.identity.nodeName === "life-target" && e.kind === "finished");

		expect(sourceStarted).toHaveLength(1);
		expect(sourceFinished?.framesDone).toBe(200);
		expect(targetFinished?.framesDone).toBe(200);
	});

	it("delivers events for all three nodes with correct identity", async () => {
		const source = new LifeSource([block(1, 0, 100)]);
		const transform = new LifeTransform();
		const target = new LifeTarget();

		source.to(transform);
		transform.to(target);

		const identities = new Set<string>();
		const job = source.createRenderJob();

		job.events.on("started", (identity) => identities.add(identity.nodeName));
		job.events.on("progress", (identity) => identities.add(identity.nodeName));
		job.events.on("finished", (identity) => identities.add(identity.nodeName));

		await job.render();

		expect(identities).toEqual(new Set(["life-source", "life-transform", "life-target"]));
	});
});

function destroyContext(): import("./node").StreamContext {
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
		super({ properties: {} } as unknown as BufferedAudioNode);
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
		super({ properties: {} } as unknown as BufferedAudioNode);
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
