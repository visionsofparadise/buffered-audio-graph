import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StreamSetupContext } from "./node/stream";
import type { Block } from "./node/stream/block";
import { SourceNode } from "./node/source";
import { BufferedSourceStream, type SourceMetadata, type SourceNodeProperties } from "./node/stream/source";
import { BufferedTargetStream, TargetNode } from "./node/stream/target";
import { UnbufferedTransformStream } from "./node/stream/transform/unbuffered-transform";
import { TransformNode, type TransformNodeProperties } from "./node/transform";
import { RenderJob } from "./render-job";
import { createRenderTemporaryDirectory, scavengeRenderTemporaryDirectories } from "./utils/render-temporary-directory";

vi.mock("node:fs/promises", { spy: true });
vi.mock("./utils/render-temporary-directory", { spy: true });

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

class TemporaryDirectoryTargetStream extends MockTargetStream {
	temporaryDirectory?: string;

	override async _setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> {
		this.temporaryDirectory = context.temporaryDirectory;
		await writeFile(join(context.temporaryDirectory, "marker"), "owned by render");
		await super._setup(input, context);
	}
}

class TemporaryDirectoryTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "temporary-directory-target";
	static override readonly schema = z.object({});
	static override readonly Stream = TemporaryDirectoryTargetStream;
}

class TemporaryDirectoryFailingTargetStream extends TemporaryDirectoryTargetStream {
	override async _write(): Promise<void> {
		throw new Error("temporary target failed");
	}
}

class TemporaryDirectoryFailingTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "temporary-directory-failing-target";
	static override readonly schema = z.object({});
	static override readonly Stream = TemporaryDirectoryFailingTargetStream;
}

const setupFailure = new Error("setup failed");
const cleanupFailure = new Error("cleanup failed");
const directoryCleanupFailure = new Error("directory cleanup failed");

class RejectingSetupAndDestroyTargetStream extends BufferedTargetStream {
	temporaryDirectory?: string;

	override async _setup(_input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> {
		this.temporaryDirectory = context.temporaryDirectory;
		await writeFile(join(context.temporaryDirectory, "marker"), "owned by render");
		throw setupFailure;
	}

	override _write(): void {}

	override _close(): void {}

	override _destroy(): void {
		throw cleanupFailure;
	}
}

class RejectingSetupAndDestroyTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "rejecting-setup-and-destroy-target";
	static override readonly schema = z.object({});
	static override readonly Stream = RejectingSetupAndDestroyTargetStream;
}

class RecordingDestroyTargetStream extends BufferedTargetStream {
	destroyCalled = false;
	temporaryDirectory?: string;

	override async _setup(_input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> {
		this.temporaryDirectory = context.temporaryDirectory;
		await writeFile(join(context.temporaryDirectory, "marker"), "owned by render");
	}

	override _write(): void {}

	override _close(): void {}

	override _destroy(): void {
		this.destroyCalled = true;
	}
}

class RecordingDestroyTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "recording-destroy-target";
	static override readonly schema = z.object({});
	static override readonly Stream = RecordingDestroyTargetStream;
}

class AbortWaitingTargetStream extends BufferedTargetStream {
	temporaryDirectory?: string;
	abortedBeforeDestroy = false;
	observedAbort = false;
	private signal?: AbortSignal;

	override _setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> | void {
		this.temporaryDirectory = context.temporaryDirectory;
		this.signal = context.signal;

		return super._setup(input, context);
	}

	override async _write(): Promise<void> {
		const signal = this.signal;

		if (!signal) throw new Error("missing render signal");

		if (signal.aborted) {
			this.observedAbort = true;
			return;
		}

		await new Promise<void>((resolve) => {
			signal.addEventListener(
				"abort",
				() => {
					this.observedAbort = true;
					resolve();
				},
				{ once: true },
			);
		});
	}

	override _close(): void {}

	override _destroy(): void {
		this.abortedBeforeDestroy = this.signal?.aborted === true;
	}
}

class AbortWaitingTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "abort-waiting-target";
	static override readonly schema = z.object({});
	static override readonly Stream = AbortWaitingTargetStream;
}

async function expectMissing(path: string): Promise<void> {
	await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function targetStream(job: RenderJob, node: TargetNode): MockTargetStream {
	return job.streams.get(node)?.[0] as MockTargetStream;
}

describe("RenderJob execution", () => {
	it("does not touch temporary-directory helpers until render starts", async () => {
		vi.clearAllMocks();

		const source = new MockSource([]);
		const target = new MockTarget();

		source.to(target);

		const job = source.createRenderJob();

		expect(scavengeRenderTemporaryDirectories).not.toHaveBeenCalled();
		expect(createRenderTemporaryDirectory).not.toHaveBeenCalled();

		await job.render();

		expect(scavengeRenderTemporaryDirectories).toHaveBeenCalledTimes(1);
		expect(createRenderTemporaryDirectory).toHaveBeenCalledTimes(1);
	});

	it("removes its temporary directory after a successful render", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const target = new TemporaryDirectoryTarget();

		source.to(target);

		const job = source.createRenderJob();
		const stream = job.streams.get(target)?.[0] as TemporaryDirectoryTargetStream;

		expect(stream.temporaryDirectory).toBeUndefined();

		await job.render();

		expect(stream.temporaryDirectory).toBeDefined();
		await expectMissing(stream.temporaryDirectory!);
	});

	it("removes its temporary directory after render work fails", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const target = new TemporaryDirectoryFailingTarget();

		source.to(target);

		const job = source.createRenderJob();
		const stream = job.streams.get(target)?.[0] as TemporaryDirectoryFailingTargetStream;

		await expect(job.render()).rejects.toThrow("temporary target failed");

		expect(stream.temporaryDirectory).toBeDefined();
		await expectMissing(stream.temporaryDirectory!);
	});

	it("destroys every stream, removes the directory, and aggregates work and cleanup errors", async () => {
		const source = new MockSource([]);
		const rejecting = new RejectingSetupAndDestroyTarget();
		const recording = new RecordingDestroyTarget();

		source.to(rejecting);
		source.to(recording);

		const job = source.createRenderJob();
		const rejectingStream = job.streams.get(rejecting)?.[0] as RejectingSetupAndDestroyTargetStream;
		const recordingStream = job.streams.get(recording)?.[0] as RecordingDestroyTargetStream;
		const remove = vi.mocked(rm);

		remove.mockRejectedValueOnce(directoryCleanupFailure);

		let thrown: unknown;

		try {
			await job.render();
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toEqual([setupFailure, cleanupFailure, directoryCleanupFailure]);
		expect(recordingStream.destroyCalled).toBe(true);
		expect(rejectingStream.temporaryDirectory).toBeDefined();

		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

		await actual.rm(rejectingStream.temporaryDirectory!, { recursive: true, force: true });
	});

	it("rethrows a sole directory cleanup failure unchanged after destruction and clears liveness", async () => {
		vi.useFakeTimers();

		try {
			const source = new MockSource([]);
			const target = new RecordingDestroyTarget();

			source.to(target);

			const job = source.createRenderJob();
			const stream = job.streams.get(target)?.[0] as RecordingDestroyTargetStream;

			vi.mocked(rm).mockRejectedValueOnce(directoryCleanupFailure);

			await expect(job.render()).rejects.toBe(directoryCleanupFailure);

			expect(stream.destroyCalled).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
			expect(stream.temporaryDirectory).toBeDefined();

			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

			await actual.rm(stream.temporaryDirectory!, { recursive: true, force: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts the shared signal before destroying streams after a branch fails", async () => {
		const source = new MockSource([createBlock(1, 0, 100)]);
		const failing = new FailingTarget();
		const waiting = new AbortWaitingTarget();

		source.to(failing);
		source.to(waiting);

		const job = source.createRenderJob();
		const waitingStream = job.streams.get(waiting)?.[0] as AbortWaitingTargetStream;

		await expect(job.render()).rejects.toThrow("write failed");

		expect(waitingStream.observedAbort).toBe(true);
		expect(waitingStream.abortedBeforeDestroy).toBe(true);
		expect(waitingStream.temporaryDirectory).toBeDefined();
		await expectMissing(waitingStream.temporaryDirectory!);
	});

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
