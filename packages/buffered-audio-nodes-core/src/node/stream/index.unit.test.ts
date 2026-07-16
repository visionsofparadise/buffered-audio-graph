import { describe, expect, it } from "vitest";
import { BufferedStream, type FinishedPayload, type LogPayload, type ProgressPayload, type RenderEvents, type StartedPayload, type StreamPhase } from ".";
import type { BufferedAudioNode } from "..";
import { createTestStreamContext } from "../../testing/contexts";

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
		const { context } = createTestStreamContext();
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
		const stream = new ProbeStream(node, createTestStreamContext().context);

		expect(stream.properties).toBe(node.properties);
	});
});

describe("BufferedStream.emitProgress", () => {
	it("emits on every call, carrying phase, frames, and createdAt", () => {
		const { context, events } = createTestStreamContext();
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
		const { context, events } = createTestStreamContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const collected = collectProgress(events);

		stream.emitProgressPublic("emit", 5);

		expect(collected[0]).toEqual({ phase: "emit", framesDone: 5, framesTotal: undefined, createdAt: expect.any(Number) });
	});
});

describe("BufferedStream lifecycle emits", () => {
	it("emitStarted carries a payload stamped with createdAt", () => {
		const { context, events } = createTestStreamContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const payloads: Array<StartedPayload> = [];

		events.on("started", (_identity, payload) => payloads.push(payload));
		stream.emitStartedPublic();

		expect(payloads).toEqual([{ createdAt: expect.any(Number) }]);
	});

	it("emitFinished stamps createdAt onto the payload", () => {
		const { context, events } = createTestStreamContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const finished: Array<FinishedPayload> = [];

		events.on("finished", (_identity, payload) => finished.push(payload));
		stream.emitFinishedPublic({ framesDone: 42, processingMs: 5 });

		expect(finished[0]).toEqual({ framesDone: 42, processingMs: 5, createdAt: expect.any(Number) });
	});
});

describe("BufferedStream.log", () => {
	it("emits once with level, message, data, and createdAt", () => {
		const { context, events } = createTestStreamContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const logs: Array<LogPayload> = [];

		events.on("log", (_identity, payload) => logs.push(payload));
		stream.logPublic("m", { a: 1 }, "warn");

		expect(logs).toEqual([{ level: "warn", message: "m", data: { a: 1 }, createdAt: expect.any(Number) }]);
	});

	it("defaults to info", () => {
		const { context, events } = createTestStreamContext();
		const stream = new ProbeStream(fakeNode("probe"), context);
		const logs: Array<LogPayload> = [];

		events.on("log", (_identity, payload) => logs.push(payload));
		stream.logPublic("hi");

		expect(logs[0]?.level).toBe("info");
	});
});
