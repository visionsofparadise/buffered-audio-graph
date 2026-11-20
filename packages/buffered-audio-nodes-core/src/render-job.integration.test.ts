import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StreamSetupContext } from "./node/stream";
import type { Block } from "./node/stream/block";
import { SourceNode } from "./node/source";
import { BufferedAudioNode } from "./node";
import {
	BufferedSourceStream,
	type SourceMetadata,
	type SourceMetadataOptions,
	type SourceNodeProperties,
} from "./node/stream/source";
import { BufferedTargetStream, TargetNode, type TargetNodeProperties } from "./node/stream/target";
import { UnbufferedTransformStream } from "./node/stream/transform/unbuffered-transform";
import { TransformNode, type TransformNodeProperties } from "./node/transform";
import { RenderJob } from "./render-job";
import { createRenderTemporaryDirectory, scavengeRenderTemporaryDirectories } from "./utils/render-temporary-directory";

vi.mock("node:fs/promises", { spy: true });
vi.mock("./utils/render-temporary-directory", { spy: true });

function createSlowTransform(log: Array<string>, longCallMs: number): TransformNode {
	let calls = 0;
	let inCall = false;

	class SlowTransformStream extends UnbufferedTransformStream {
		override async *_transform(block: Block): AsyncGenerator<Block> {
			calls += 1;
			inCall = true;

			if (calls === 2) {
				await new Promise((resolve) => setTimeout(resolve, longCallMs));
				log.push("long call ends");
			}

			inCall = false;

			yield block;
		}

		override _destroy(): void {
			log.push(`slow: _destroy (inCall=${String(inCall)})`);
		}
	}

	class SlowTransform extends TransformNode {
		static override readonly packageName = "test";
		static override readonly nodeName = "slow-transform";
		static override readonly schema = z.object({});
		static override readonly Stream = SlowTransformStream;
	}

	return new SlowTransform();
}

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

	it("tears an upstream transform down only after its in-flight call returns, before render settles", async () => {
		const log: Array<string> = [];
		const slow = createSlowTransform(log, 300);
		const source = new MockSource([createBlock(1, 0, 100), createBlock(2, 100, 100), createBlock(3, 200, 100)]);
		const passthrough = new MockTransform();
		const failing = new FailingTarget();

		source.to(slow);
		slow.to(passthrough);
		passthrough.to(failing);

		await source
			.createRenderJob({ highWaterMark: 1 })
			.render()
			.catch(() => log.push("render rejected"));

		expect(log).toEqual(["long call ends", "slow: _destroy (inCall=false)", "render rejected"]);
	});

	it("reports a branch's own failure ahead of the abort it causes in a sibling branch", async () => {
		class AbortRejectingTargetStream extends AbortWaitingTargetStream {
			override async _write(): Promise<void> {
				await super._write();

				throw new DOMException("This operation was aborted", "AbortError");
			}
		}

		class AbortRejectingTarget extends TargetNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "abort-rejecting-target";
			static override readonly schema = z.object({});
			static override readonly Stream = AbortRejectingTargetStream;
		}

		const source = new MockSource([createBlock(1, 0, 100)]);

		source.to(new AbortRejectingTarget());
		source.to(new FailingTarget());

		await expect(source.createRenderJob().render()).rejects.toThrow("write failed");
	});

	it("tears a source down only after its in-flight read returns when the render aborts", async () => {
		const log: Array<string> = [];

		class SlowReadSourceStream extends BufferedSourceStream {
			private reads = 0;

			override async getMetadata(): Promise<SourceMetadata> {
				return { sampleRate: 44100, channels: 1 };
			}

			override async _read(): Promise<Block | undefined> {
				this.reads += 1;

				if (this.reads === 2) {
					await new Promise((resolve) => setTimeout(resolve, 300));
					log.push("read 2 ends");
				}

				return this.reads > 4 ? undefined : createBlock(this.reads, (this.reads - 1) * 100, 100);
			}

			override _destroy(): void {
				log.push("source: _destroy");
			}
		}

		class SlowReadSource extends SourceNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "slow-read-source";
			static override readonly schema = z.object({});
			static override readonly Stream = SlowReadSourceStream;
		}

		const source = new SlowReadSource({});
		const passthrough = new MockTransform();
		const controller = new AbortController();

		source.to(passthrough);
		passthrough.to(new MockTarget());

		const render = source
			.createRenderJob({ highWaterMark: 1, signal: controller.signal })
			.render()
			.then(
				() => log.push("render resolved"),
				() => log.push("render rejected"),
			);

		setTimeout(() => controller.abort(), 100);
		await render;

		expect(log).toEqual(["read 2 ends", "source: _destroy", "render rejected"]);
	});

	it("tears a target down only after its in-flight write returns when a sibling's setup fails", async () => {
		const log: Array<string> = [];

		class SlowWriteTargetStream extends BufferedTargetStream {
			override async _write(): Promise<void> {
				await new Promise((resolve) => setTimeout(resolve, 500));
				log.push("write ends");
			}

			override _close(): void {}

			override _destroy(): void {
				log.push("slow target: _destroy");
			}
		}

		class SlowWriteTarget extends TargetNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "slow-write-target";
			static override readonly schema = z.object({});
			static override readonly Stream = SlowWriteTargetStream;
		}

		class FailingSetupTransformStream extends UnbufferedTransformStream {
			override async _setup(): Promise<void> {
				await new Promise((resolve) => setTimeout(resolve, 200));

				throw new Error("transform setup failed");
			}

			override *_transform(block: Block): Iterable<Block> {
				yield block;
			}
		}

		class FailingSetupTransform extends TransformNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "failing-setup-transform";
			static override readonly schema = z.object({});
			static override readonly Stream = FailingSetupTransformStream;
		}

		const source = new MockSource([createBlock(1, 0, 100), createBlock(2, 100, 100), createBlock(3, 200, 100)]);
		const failingSetup = new FailingSetupTransform();

		source.to(new SlowWriteTarget());
		source.to(failingSetup);
		failingSetup.to(new MockTarget());

		await source
			.createRenderJob({ highWaterMark: 1 })
			.render()
			.catch((error: unknown) => log.push(`render rejected: ${(error as Error).message}`));

		expect(log).toEqual(["write ends", "slow target: _destroy", "render rejected: transform setup failed"]);
	});

	it("rejects promptly when a fanned-out target's setup fails before it reads its branch", async () => {
		class EarlyFailingTargetStream extends BufferedTargetStream {
			override async _setup(): Promise<void> {
				await Promise.resolve();

				throw new Error("target setup failed");
			}

			override _write(): void {}

			override _close(): void {}
		}

		class EarlyFailingTarget extends TargetNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "early-failing-target";
			static override readonly schema = z.object({});
			static override readonly Stream = EarlyFailingTargetStream;
		}

		const blocks = Array.from({ length: 8 }, (_, index) => createBlock(index, index * 100, 100));
		const source = new MockSource(blocks);

		source.to(new EarlyFailingTarget());
		source.to(new MockTarget());

		await expect(source.createRenderJob({ highWaterMark: 1 }).render()).rejects.toThrow("target setup failed");
	}, 2000);

	it("reports an upstream _destroy error raised while a cancel tore the stream down", async () => {
		class ThrowingDestroyTransformStream extends UnbufferedTransformStream {
			override *_transform(block: Block): Iterable<Block> {
				yield block;
			}

			override _destroy(): void {
				throw new Error("destroy failed");
			}
		}

		class ThrowingDestroyTransform extends TransformNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "throwing-destroy-transform";
			static override readonly schema = z.object({});
			static override readonly Stream = ThrowingDestroyTransformStream;
		}

		const source = new MockSource([createBlock(1, 0, 100), createBlock(2, 100, 100)]);
		const transform = new ThrowingDestroyTransform();

		source.to(transform);
		transform.to(new FailingTarget());

		const error = await source
			.createRenderJob()
			.render()
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors.map((entry: Error) => entry.message)).toEqual([
			"write failed",
			"destroy failed",
		]);
	});

	it("reports a transform's own error first and its _destroy error once", async () => {
		class FailingTransformStream extends UnbufferedTransformStream {
			override _transform(): Iterable<Block> {
				throw new Error("transform failed");
			}

			override _destroy(): void {
				throw new Error("destroy failed");
			}
		}

		class FailingTransform extends TransformNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "failing-transform";
			static override readonly schema = z.object({});
			static override readonly Stream = FailingTransformStream;
		}

		const source = new MockSource([createBlock(1, 0, 100), createBlock(2, 100, 100)]);
		const transform = new FailingTransform();

		source.to(transform);
		transform.to(new MockTarget());

		const error = await source
			.createRenderJob()
			.render()
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors.map((entry: Error) => entry.message)).toEqual([
			"transform failed",
			"destroy failed",
		]);
	});

	it("waits for every fan-out branch to settle before tearing down after an abort", async () => {
		const log: Array<string> = [];
		const slow = createSlowTransform(log, 500);
		const blocks = Array.from({ length: 8 }, (_, index) => createBlock(index, index * 100, 100));
		const source = new MockSource(blocks);
		const passthrough = new MockTransform();
		const controller = new AbortController();

		source.to(slow);
		source.to(passthrough);
		slow.to(new MockTarget());
		passthrough.to(new MockTarget());

		const render = source
			.createRenderJob({ highWaterMark: 1, signal: controller.signal })
			.render()
			.then(
				() => log.push("render resolved"),
				() => log.push("render rejected"),
			);

		setTimeout(() => controller.abort(), 150);
		await render;

		expect(log).toEqual(["long call ends", "slow: _destroy (inCall=false)", "render rejected"]);
	});
});

interface HookErrorSourceProperties extends SourceNodeProperties {
	readonly count: number;
	readonly readFails: boolean;
	readonly destroyFails: boolean;
}

class HookErrorSourceStream extends BufferedSourceStream<HookErrorSource> {
	private index = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1 };
	}

	override async _read(): Promise<Block | undefined> {
		if (this.properties.readFails) throw new Error("read failed");

		if (this.index >= this.properties.count) return undefined;

		this.index += 1;

		return createBlock(this.index, (this.index - 1) * 100, 100);
	}

	override _destroy(): void {
		if (this.properties.destroyFails) throw new Error("destroy failed");
	}
}

class HookErrorSource extends SourceNode<HookErrorSourceProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "hook-error-source";
	static override readonly schema = z.object({});
	static override readonly Stream = HookErrorSourceStream;

	constructor(options: { count?: number; readFails?: boolean; destroyFails?: boolean }) {
		super({
			count: options.count ?? 8,
			readFails: options.readFails ?? false,
			destroyFails: options.destroyFails ?? false,
		});
	}
}

interface HookErrorTransformProperties extends TransformNodeProperties {
	readonly transformFails: boolean;
	readonly destroyFails: boolean;
}

class HookErrorTransformStream extends UnbufferedTransformStream<HookErrorTransform> {
	override *_transform(block: Block): Iterable<Block> {
		if (this.properties.transformFails) throw new Error("transform failed");

		yield block;
	}

	override _destroy(): void {
		if (this.properties.destroyFails) throw new Error("destroy failed");
	}
}

class HookErrorTransform extends TransformNode<HookErrorTransformProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "hook-error-transform";
	static override readonly schema = z.object({});
	static override readonly Stream = HookErrorTransformStream;

	constructor(options: { transformFails?: boolean; destroyFails?: boolean }) {
		super({ transformFails: options.transformFails ?? false, destroyFails: options.destroyFails ?? false });
	}
}

interface HookErrorTargetProperties extends TargetNodeProperties {
	readonly writeFailsAfterMs?: number;
	readonly destroyFails: boolean;
}

class HookErrorTargetStream extends BufferedTargetStream<HookErrorTarget> {
	override async _write(): Promise<void> {
		const delayMs = this.properties.writeFailsAfterMs;

		if (delayMs === undefined) return;

		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

		throw new Error("write failed");
	}

	override _close(): void {}

	override _destroy(): void {
		if (this.properties.destroyFails) throw new Error("destroy failed");
	}
}

class HookErrorTarget extends TargetNode<HookErrorTargetProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "hook-error-target";
	static override readonly schema = z.object({});
	static override readonly Stream = HookErrorTargetStream;

	constructor(options: { writeFailsAfterMs?: number; destroyFails?: boolean }) {
		super({ writeFailsAfterMs: options.writeFailsAfterMs, destroyFails: options.destroyFails ?? false });
	}
}

async function renderFailure(source: SourceNode): Promise<unknown> {
	return source
		.createRenderJob()
		.render()
		.then(
			() => undefined,
			(reason: unknown) => reason,
		);
}

function expectHookThenDestroyError(error: unknown, hookMessage: string): void {
	expect(error).toBeInstanceOf(AggregateError);
	expect((error as AggregateError).message).toBe("Render and cleanup failed");
	expect((error as AggregateError).errors.map((entry: Error) => entry.message)).toEqual([
		hookMessage,
		"destroy failed",
	]);
}

describe("RenderJob hook errors ahead of teardown errors", () => {
	it("reports a source's read error, then its _destroy error", async () => {
		const source = new HookErrorSource({ readFails: true, destroyFails: true });

		source.to(new HookErrorTarget({}));

		expectHookThenDestroyError(await renderFailure(source), "read failed");
	});

	it("reports a target's write error, then the _destroy error of the source its cancel tore down", async () => {
		const source = new HookErrorSource({ destroyFails: true });

		source.to(new HookErrorTarget({ writeFailsAfterMs: 0 }));

		expectHookThenDestroyError(await renderFailure(source), "write failed");
	});

	it("reports a target's write error, then the _destroy error of a transform parked at a yield", async () => {
		const source = new HookErrorSource({});
		const transform = new HookErrorTransform({ destroyFails: true });

		source.to(transform);
		transform.to(new HookErrorTarget({ writeFailsAfterMs: 20 }));

		expectHookThenDestroyError(await renderFailure(source), "write failed");
	});

	it("reports a source's read error ahead of the _destroy error of the target its abort tore down", async () => {
		const source = new HookErrorSource({ readFails: true });

		source.to(new HookErrorTarget({ destroyFails: true }));

		expectHookThenDestroyError(await renderFailure(source), "read failed");
	});

	it("reports a transform's error ahead of the _destroy error of the target its abort tore down", async () => {
		const source = new HookErrorSource({});
		const transform = new HookErrorTransform({ transformFails: true });

		source.to(transform);
		transform.to(new HookErrorTarget({ destroyFails: true }));

		expectHookThenDestroyError(await renderFailure(source), "transform failed");
	});
});

describe("RenderJob aborts and the metadata signal", () => {
	it("aborts sibling branches at once when its own setup of a branch fails", async () => {
		const log: Array<string> = [];

		class StraySourceStream extends BufferedSourceStream {
			override async getMetadata(): Promise<SourceMetadata> {
				return { sampleRate: 44100, channels: 1 };
			}

			override async _read(): Promise<Block | undefined> {
				return undefined;
			}
		}

		class StrayNode extends BufferedAudioNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "stray";
			static override readonly schema = z.object({});
			static override readonly Stream = StraySourceStream;
		}

		class SlowSetupTransformStream extends UnbufferedTransformStream {
			override async _setup(context: StreamSetupContext): Promise<void> {
				log.push("X _setup start");
				context.signal?.addEventListener("abort", () => log.push("X sees render abort"), { once: true });
				await new Promise((resolve) => setTimeout(resolve, 300));
				log.push("X _setup end");
			}

			override *_transform(block: Block): Iterable<Block> {
				yield block;
			}
		}

		class SlowSetupTransform extends TransformNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "slow-setup-transform";
			static override readonly schema = z.object({});
			static override readonly Stream = SlowSetupTransformStream;
		}

		class LoggingSetupTargetStream extends MockTargetStream {
			override _setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> | void {
				log.push("T2 _setup start");

				return super._setup(input, context);
			}
		}

		class LoggingSetupTarget extends TargetNode {
			static override readonly packageName = "test";
			static override readonly nodeName = "logging-setup-target";
			static override readonly schema = z.object({});
			static override readonly Stream = LoggingSetupTargetStream;
		}

		const source = new MockSource([createBlock(1, 0, 100), createBlock(2, 100, 100)]);
		const slow = new SlowSetupTransform();

		source.properties = { ...source.properties, children: [new StrayNode()] };
		source.to(slow);
		slow.to(new LoggingSetupTarget());

		await expect(source.createRenderJob().render()).rejects.toThrow('Unexpected stream type for node "stray"');
		expect(log).toEqual(["X _setup start", "X sees render abort", "X _setup end"]);
	});

	it("rejects an already-aborted render with its reason before any work", async () => {
		vi.clearAllMocks();

		const reason = new Error("aborted before render");
		const source = new MockSource([createBlock(1, 0, 100)]);

		source.to(new MockTarget());

		const job = source.createRenderJob({ signal: AbortSignal.abort(reason) });
		const getMetadata = vi.spyOn(job.streams.get(source)?.[0] as MockSourceStream, "getMetadata");

		await expect(job.render()).rejects.toBe(reason);
		expect(getMetadata).not.toHaveBeenCalled();
		expect(scavengeRenderTemporaryDirectories).not.toHaveBeenCalled();
		expect(createRenderTemporaryDirectory).not.toHaveBeenCalled();
	});

	it("passes the render signal to getMetadata, so an abort during it rejects the render", async () => {
		let received: AbortSignal | undefined;

		class SignalMetadataSourceStream extends MockSourceStream {
			override getMetadata(options?: SourceMetadataOptions): Promise<SourceMetadata> {
				const signal = options?.signal;

				received = signal;

				return new Promise((_resolve, reject) => {
					if (!signal) {
						reject(new Error("getMetadata received no signal"));

						return;
					}

					signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
				});
			}
		}

		class SignalMetadataSource extends MockSource {
			static override readonly Stream = SignalMetadataSourceStream;
		}

		const reason = new Error("aborted during getMetadata");
		const controller = new AbortController();
		const source = new SignalMetadataSource([createBlock(1, 0, 100)]);

		source.to(new MockTarget());

		const render = source.createRenderJob({ signal: controller.signal }).render();

		setTimeout(() => controller.abort(reason), 20);

		await expect(render).rejects.toBe(reason);
		expect(received).toBeInstanceOf(AbortSignal);
		expect(received?.aborted).toBe(true);
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
