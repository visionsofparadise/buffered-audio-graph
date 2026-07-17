import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StreamSetupContext } from "./node/stream";
import type { Block } from "./node/stream/block";
import { BufferedSourceStream, SourceNode, type SourceMetadata, type SourceNodeProperties } from "./node/stream/source";
import { BufferedTargetStream, TargetNode } from "./node/stream/target";
import { UnbufferedTransformStream } from "./node/stream/transform/unbuffered-transform";
import { TransformNode, type TransformNodeProperties } from "./node/transform";
import { RenderJob } from "./render-job";

function createBlock(value: number, offset: number, frames: number, sampleRate = 44100): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate, bitDepth: 32 };
}

interface MockSourceProperties extends SourceNodeProperties {
	readonly blocks: Array<Block>;
	readonly metadata: SourceMetadata;
}

class MockSourceStream extends BufferedSourceStream<MockSource> {
	private index = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return this.properties.metadata;
	}

	override async _read(): Promise<Block | undefined> {
		const blocks = this.properties.blocks;
		const block = blocks[this.index];

		if (!block) return undefined;
		this.index += 1;

		return block;
	}
}

class MockSource extends SourceNode<MockSourceProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "mock-source";
	static override readonly schema = z.object({});
	static override readonly Stream = MockSourceStream;

	constructor(blocks: Array<Block> = [], metadata: SourceMetadata = { sampleRate: 44100, channels: 1 }) {
		super({ blocks, metadata });
	}
}

class MockTransformStream extends UnbufferedTransformStream {
	observedSampleRate?: number;

	override _setup(context: StreamSetupContext): void {
		this.observedSampleRate = context.sampleRate;
	}

	override *_transform(block: Block): Iterable<Block> {
		yield block;
	}
}

class MockTransform extends TransformNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "mock-transform";
	static override readonly schema = z.object({});
	static override readonly Stream = MockTransformStream;
}

interface RateTransformProperties extends TransformNodeProperties {
	readonly rate: number;
	readonly declare: boolean;
}

class RateTransformStream extends UnbufferedTransformStream<RateTransform> {
	override _setup(context: StreamSetupContext): void {
		if (this.properties.declare) context.sampleRate = this.properties.rate;
	}

	override *_transform(block: Block): Iterable<Block> {
		yield { ...block, sampleRate: this.properties.rate };
	}
}

class RateTransform extends TransformNode<RateTransformProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "rate-transform";
	static override readonly schema = z.object({});
	static override readonly Stream = RateTransformStream;

	constructor(rate: number, declare: boolean) {
		super({ rate, declare });
	}
}

class MockTargetStream extends BufferedTargetStream {
	readonly receivedBlocks: Array<Block> = [];
	observedSampleRate?: number;
	closed = false;

	override _setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> | void {
		this.observedSampleRate = context.sampleRate;

		return super._setup(input, context);
	}

	override async _write(block: Block): Promise<void> {
		this.receivedBlocks.push(block);
	}

	override async _close(): Promise<void> {
		this.closed = true;
	}
}

class MockTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "mock-target";
	static override readonly schema = z.object({});
	static override readonly Stream = MockTargetStream;
}

class FailingTargetStream extends BufferedTargetStream {
	destroyCount = 0;

	override async _write(): Promise<void> {
		throw new Error("write failed");
	}

	override async _close(): Promise<void> {}

	override _destroy(): void {
		this.destroyCount += 1;
	}
}

class FailingTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "failing-target";
	static override readonly schema = z.object({});
	static override readonly Stream = FailingTargetStream;
}

function targetStream(job: RenderJob, node: TargetNode): MockTargetStream {
	return job.streams.get(node)?.[0] as MockTargetStream;
}

describe("RenderJob execution", () => {
	it("linear pipeline: source → transform → target", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);

		const job = source.createRenderJob();
		await job.render();

		expect(targetStream(job, target).receivedBlocks).toHaveLength(1);
		expect(targetStream(job, target).closed).toBe(true);
	});

	it("fan-out: source → two targets, both receive", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const target1 = new MockTarget();
		const target2 = new MockTarget();

		source.to(target1);
		source.to(target2);

		const job = source.createRenderJob();
		await job.render();

		expect(targetStream(job, target1).receivedBlocks).toHaveLength(1);
		expect(targetStream(job, target2).receivedBlocks).toHaveLength(1);
	});

	it("bypass: a bypassed transform is skipped, its child wired to the source", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const bypassed = new MockTransform({ bypass: true });
		const target = new MockTarget();

		source.to(bypassed);
		bypassed.to(target);

		const job = source.createRenderJob();

		expect(job.streams.has(bypassed)).toBe(false);

		await job.render();

		expect(targetStream(job, target).receivedBlocks).toHaveLength(1);
	});

	it("cycle detection throws at job construction", () => {
		const source = new MockSource([]);
		const a = new MockTransform();
		const b = new MockTransform();

		source.to(a);
		a.to(b);
		b.to(a);

		expect(() => source.createRenderJob()).toThrow(/Cycle detected/);
	});

	it("second render() throws", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const target = new MockTarget();

		source.to(target);

		const job = source.createRenderJob();
		await job.render();

		await expect(job.render()).rejects.toThrow(/single-use/);
	});

	it("streams map is populated at construction, before render", () => {
		const source = new MockSource([]);
		const target = new MockTarget();

		source.to(target);

		const job = source.createRenderJob();

		expect(job.streams.get(source)).toHaveLength(1);
		expect(job.streams.get(target)).toHaveLength(1);
	});

	it("fan-in duplicates: one node under two parents gets one stream per path", () => {
		const source = new MockSource([]);
		const firstTransform = new MockTransform();
		const secondTransform = new MockTransform();
		const shared = new MockTarget();

		source.to(firstTransform);
		source.to(secondTransform);
		firstTransform.to(shared);
		secondTransform.to(shared);

		const job = source.createRenderJob();

		expect(job.streams.get(shared)).toHaveLength(2);
	});

	it("timing is set after render", async () => {
		const source = new MockSource([createBlock(1, 0, 100)], { sampleRate: 44100, channels: 1, durationFrames: 100 });
		const target = new MockTarget();

		source.to(target);

		const job = source.createRenderJob();

		expect(job.timing).toBeUndefined();

		await job.render();

		expect(job.timing).toBeDefined();
		expect(job.timing?.audioDurationMs).toBeGreaterThan(0);
	});

	it("emits liveness while pending and clears the interval after success", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));

		try {
			const source = new MockSource([]);
			const target = new MockTarget();

			source.to(target);

			const job = source.createRenderJob();
			const sourceStream = job.streams.get(source)?.[0] as MockSourceStream;
			let resolveMetadata!: (metadata: SourceMetadata) => void;
			const metadata = new Promise<SourceMetadata>((resolve) => {
				resolveMetadata = resolve;
			});

			vi.spyOn(sourceStream, "getMetadata").mockReturnValue(metadata);

			const payloads: Array<{ createdAt: number; elapsedMs: number }> = [];

			job.events.on("liveness", (payload) => payloads.push(payload));

			const render = job.render();

			await vi.advanceTimersByTimeAsync(29_999);
			expect(payloads).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			expect(payloads).toEqual([{ createdAt: Date.parse("2026-07-16T12:00:30.000Z"), elapsedMs: 30_000 }]);

			await vi.advanceTimersByTimeAsync(30_000);
			expect(payloads).toHaveLength(2);

			resolveMetadata({ sampleRate: 44100, channels: 1, durationFrames: 0 });
			await render;

			expect(vi.getTimerCount()).toBe(0);
			expect(payloads).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the liveness interval after a rejected render", async () => {
		vi.useFakeTimers();

		try {
			const source = new MockSource([createBlock(1, 0, 100)]);
			const target = new FailingTarget();

			source.to(target);

			const job = source.createRenderJob();

			await expect(job.render()).rejects.toThrow("write failed");

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a rate-changing transform's cursor reaches its own subtree and not its siblings", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const resample = new RateTransform(48000, true);
		const resampled = new MockTarget();
		const sibling = new MockTransform();
		const untouched = new MockTarget();

		source.to(resample);
		resample.to(resampled);
		source.to(sibling);
		sibling.to(untouched);

		const job = source.createRenderJob();
		await job.render();

		expect(targetStream(job, resampled).observedSampleRate).toBe(48000);
		expect((job.streams.get(sibling)?.[0] as MockTransformStream).observedSampleRate).toBe(44100);
		expect(targetStream(job, untouched).observedSampleRate).toBe(44100);
	});

	it("a transform that re-tags blocks without declaring the rate fails the render, naming itself", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const dishonest = new RateTransform(48000, false);
		const target = new MockTarget();

		source.to(dishonest);
		dishonest.to(target);

		const job = source.createRenderJob();

		await expect(job.render()).rejects.toThrow(/^rate-transform: emitted 48000 Hz where 44100 Hz was declared/);
	});

	it("destroy backstop runs on a stream that errors mid-render", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const failing = new FailingTarget();

		source.to(failing);

		const job = source.createRenderJob();

		await expect(job.render()).rejects.toThrow("write failed");

		const stream = job.streams.get(failing)?.[0] as FailingTargetStream;
		expect(stream.destroyCount).toBe(1);
	});
});

describe("render leaf-must-be-a-target validation", () => {
	it("throws on a leaf transform, naming it", () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const transform = new MockTransform();

		source.to(transform);

		expect(() => source.createRenderJob()).toThrow(/Graph leaf "mock-transform" is not a target/);
	});

	it("throws on a childless source", () => {
		const source = new MockSource([createBlock(1, 0, 100)]);

		expect(() => source.createRenderJob()).toThrow(/Graph leaf "mock-source" is not a target/);
	});

	it("throws when the only target is bypassed", () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const target = new MockTarget({ bypass: true });

		source.to(target);

		expect(() => source.createRenderJob()).toThrow(/is not a target/);
	});

	it("constructs a valid source → transform → target without throwing", () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const transform = new MockTransform();
		const target = new MockTarget();

		source.to(transform);
		transform.to(target);

		expect(() => source.createRenderJob()).not.toThrow();
	});
});
