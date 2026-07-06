import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AudioChunk, StreamContext, StreamEvent, NodeIdentity } from "./node";
import { BufferedSourceStream, SourceNode, type SourceMetadata } from "./source";
import { BufferedTargetStream, TargetNode } from "./target";
import { BufferedTransformStream, TransformNode } from "./transform";
import { BufferedStream, UNKNOWN_TOTAL_QUANTUM_FRAMES, type LogPayload, type ProgressPayload, type StreamPhase } from "./stream";

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

function collectProgress(stream: BufferedStream): Array<ProgressPayload> {
	const out: Array<ProgressPayload> = [];

	stream.events.on("progress", (payload) => out.push(payload));

	return out;
}

describe("BufferedStream.emitProgress throttle", () => {
	it("known total: emits at 0, each quantum-boundary crossing, and forced final — not every increment", () => {
		const stream = new ProbeStream({});
		const events = collectProgress(stream);
		const total = 1000;

		for (let done = 0; done <= total; done += 10) {
			stream.emit("read", done, total, done === total ? { force: true } : undefined);
		}

		const framesDone = events.map((e) => e.framesDone);

		expect(framesDone[0]).toBe(0);
		expect(framesDone.at(-1)).toBe(1000);
		// quantum = 100; ~11 boundary emissions (0,100,...,900) plus forced final at 1000
		expect(events.length).toBeGreaterThanOrEqual(10);
		expect(events.length).toBeLessThanOrEqual(13);
		expect(events.length).toBeLessThan(50);
	});

	it("unknown total: boundaries at UNKNOWN_TOTAL_QUANTUM_FRAMES multiples", () => {
		const stream = new ProbeStream({});
		const events = collectProgress(stream);
		const step = UNKNOWN_TOTAL_QUANTUM_FRAMES / 4;

		for (let i = 0; i <= 8; i++) stream.emit("emit", i * step);

		// crossings at 0, 480_000, 960_000 (i = 0, 4, 8)
		expect(events.map((e) => e.framesDone)).toEqual([0, UNKNOWN_TOTAL_QUANTUM_FRAMES, UNKNOWN_TOTAL_QUANTUM_FRAMES * 2]);
	});

	it("quantumFraction is honored", () => {
		const stream = new ProbeStream({});
		stream.quantumFraction = 0.25;
		const events = collectProgress(stream);

		for (let done = 0; done <= 100; done += 5) stream.emit("read", done, 100);

		// quantum = 25 → boundaries at 0,25,50,75,100
		expect(events.map((e) => e.framesDone)).toEqual([0, 25, 50, 75, 100]);
	});

	it("force always emits regardless of boundary", () => {
		const stream = new ProbeStream({});
		const events = collectProgress(stream);

		stream.emit("write", 0, 1000);
		stream.emit("write", 5, 1000, { force: true });
		stream.emit("write", 7, 1000, { force: true });

		expect(events.map((e) => e.framesDone)).toEqual([0, 5, 7]);
	});
});

describe("BufferedStream per-phase independence", () => {
	it("interleaved phases do not suppress each other's boundaries", () => {
		const stream = new ProbeStream({});
		const events = collectProgress(stream);

		stream.emit("buffer", 0, 1000);
		stream.emit("process", 0, 1000);
		stream.emit("buffer", 100, 1000);
		stream.emit("process", 100, 1000);
		stream.emit("buffer", 200, 1000);

		const byPhase = (phase: StreamPhase): Array<number> => events.filter((e) => e.phase === phase).map((e) => e.framesDone);

		expect(byPhase("buffer")).toEqual([0, 100, 200]);
		expect(byPhase("process")).toEqual([0, 100]);
	});
});

describe("BufferedStream helpers", () => {
	it("progress() routes through the process phase throttle", () => {
		const stream = new ProbeStream({});
		const events = collectProgress(stream);

		for (let i = 0; i <= 1000; i++) stream.callProgress(i, 1000);

		expect(events.every((e) => e.phase === "process")).toBe(true);
		expect(events.length).toBeLessThan(20);
		expect(events[0]?.framesDone).toBe(0);
	});

	it("log() emits once with exact payload and level", () => {
		const stream = new ProbeStream({});
		const logs: Array<LogPayload> = [];

		stream.events.on("log", (payload) => logs.push(payload));
		stream.callLog("m", { a: 1 }, "warn");

		expect(logs).toEqual([{ level: "warn", message: "m", data: { a: 1 } }]);
	});

	it("log() defaults to info", () => {
		const stream = new ProbeStream({});
		const logs: Array<LogPayload> = [];

		stream.events.on("log", (payload) => logs.push(payload));
		stream.callLog("hi");

		expect(logs[0]?.level).toBe("info");
	});
});

class LifeSourceStream extends BufferedSourceStream {
	private index = 0;
	private readonly chunks: Array<AudioChunk>;

	constructor(properties: Record<string, unknown>, chunks: Array<AudioChunk>) {
		super(properties as never);
		this.chunks = chunks;
	}

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1, durationFrames: 200 };
	}

	override async _read(): Promise<AudioChunk | undefined> {
		const chunk = this.chunks[this.index];

		if (!chunk) return undefined;
		this.index += 1;

		return chunk;
	}

	override async _flush(): Promise<void> {}
}

class LifeSource extends SourceNode {
	static readonly packageName = "test";
	static readonly nodeName = "life-source";
	static override readonly schema = z.object({});

	readonly type = ["buffered-audio-node", "source", "life"] as const;
	get bufferSize(): number {
		return 0;
	}
	get latency(): number {
		return 0;
	}

	private readonly chunks: Array<AudioChunk>;

	constructor(chunks: Array<AudioChunk>) {
		super({});
		this.chunks = chunks;
	}

	protected override createStream(): LifeSourceStream {
		return new LifeSourceStream(this.properties as never, this.chunks);
	}

	clone(): LifeSource {
		return new LifeSource(this.chunks);
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

	readonly type = ["buffered-audio-node", "target", "life"] as const;
	get bufferSize(): number {
		return 0;
	}
	get latency(): number {
		return 0;
	}

	override createStream(): LifeTargetStream {
		return new LifeTargetStream(this.properties as never);
	}

	clone(): LifeTarget {
		return new LifeTarget();
	}
}

class LifeTransform extends TransformNode {
	static readonly packageName = "test";
	static readonly nodeName = "life-transform";
	static override readonly schema = z.object({});

	readonly type = ["buffered-audio-node", "transform", "life"] as const;
	get bufferSize(): number {
		return 0;
	}
	get latency(): number {
		return 0;
	}

	override createStream(): BufferedTransformStream {
		return new BufferedTransformStream({ ...this.properties, bufferSize: 0 });
	}

	clone(): LifeTransform {
		return new LifeTransform();
	}
}

function chunk(value: number, offset: number, frames: number): AudioChunk {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate: 44100, bitDepth: 32 };
}

describe("Lifecycle events end-to-end", () => {
	it("source emits started once and finished with framesDone; target finished with framesDone", async () => {
		const source = new LifeSource([chunk(1, 0, 100), chunk(2, 100, 100)]);
		const target = new LifeTarget();

		source.to(target);

		const events: Array<{ node: NodeIdentity; event: StreamEvent }> = [];

		await source.render({ onEvent: (node, event) => events.push({ node, event }) });

		const sourceEvents = events.filter((e) => e.node.nodeName === "life-source");
		const targetEvents = events.filter((e) => e.node.nodeName === "life-target");

		expect(sourceEvents.filter((e) => e.event.kind === "started")).toHaveLength(1);

		const sourceFinished = sourceEvents.find((e) => e.event.kind === "finished");
		expect(sourceFinished?.event).toMatchObject({ kind: "finished", framesDone: 200 });

		const targetFinished = targetEvents.find((e) => e.event.kind === "finished");
		expect(targetFinished?.event).toMatchObject({ kind: "finished", framesDone: 200 });
	});

	it("transform finished carries framesDone and processingMs", async () => {
		const source = new LifeSource([chunk(1, 0, 100), chunk(2, 100, 100)]);
		const transform = new LifeTransform();
		const target = new LifeTarget();

		source.to(transform);
		transform.to(target);

		const events: Array<{ node: NodeIdentity; event: StreamEvent }> = [];

		await source.render({ onEvent: (node, event) => events.push({ node, event }) });

		const finished = events.find((e) => e.node.nodeName === "life-transform" && e.event.kind === "finished");

		expect(finished?.event).toMatchObject({ kind: "finished", framesDone: 200 });
		expect((finished?.event as { processingMs?: number }).processingMs).toBeTypeOf("number");
	});
});

describe("onEvent aggregation", () => {
	it("delivers events for all three nodes with correct identity", async () => {
		const source = new LifeSource([chunk(1, 0, 100)]);
		const transform = new LifeTransform();
		const target = new LifeTarget();

		source.to(transform);
		transform.to(target);

		const identities = new Set<string>();

		await source.render({
			onEvent: (node) => {
				identities.add(node.nodeName);
			},
		});

		expect(identities).toEqual(new Set(["life-source", "life-transform", "life-target"]));
	});

	it("no listeners are subscribed when onEvent is omitted", async () => {
		const source = new LifeSource([chunk(1, 0, 100)]);
		const target = new LifeTarget();

		source.to(target);

		let listenerCount = -1;

		const origCreate = (source as unknown as { createStream: () => BufferedSourceStream }).createStream.bind(source);
		(source as unknown as { createStream: () => BufferedSourceStream }).createStream = () => {
			const stream = origCreate();
			const origSetup = stream.setup.bind(stream);

			stream.setup = (context: StreamContext) => {
				listenerCount = stream.events.listenerCount("progress") + stream.events.listenerCount("started") + stream.events.listenerCount("finished") + stream.events.listenerCount("log");

				return origSetup(context);
			};

			return stream;
		};

		await source.render();

		expect(listenerCount).toBe(0);
	});
});
