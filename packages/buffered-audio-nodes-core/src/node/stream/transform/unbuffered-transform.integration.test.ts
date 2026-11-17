import { describe, expect, it, vi } from "vitest";
import type { BufferedAudioNode } from "../..";
import { createBlock } from "../../../testing/blocks";
import { createTestSetupContext, createTestStreamContext } from "../../../testing/contexts";
import { drainBlocks, readableFrom } from "../../../testing/streams";
import type { ProgressPayload, RenderEvents } from "..";
import type { Block } from "../block";
import { UnbufferedTransformStream } from "./unbuffered-transform";

function nodeWith(properties: Record<string, unknown>): BufferedAudioNode {
	return { properties, constructor: { nodeName: "probe-transform" } } as unknown as BufferedAudioNode;
}

function collectProgress(events: RenderEvents): Array<ProgressPayload> {
	const out: Array<ProgressPayload> = [];

	events.on("progress", (_identity, payload) => out.push(payload));

	return out;
}

class GainStream extends UnbufferedTransformStream {
	override *_transform(block: Block): Iterable<Block> {
		yield { ...block, samples: block.samples.map((channel) => channel.map((v) => v * 2)) };
	}
}

describe("UnbufferedTransformStream._transform", () => {
	it("transforms each block in arrival order", async () => {
		const { context } = createTestStreamContext();
		const stream = new GainStream(nodeWith({}), context);
		const input = [createBlock(1, 0, 10), createBlock(2, 10, 10)];

		const output = await drainBlocks(await stream.setup(readableFrom(input), createTestSetupContext()));

		expect(output.map((b) => b.samples[0]?.[0])).toEqual([2, 4]);
	});

	it("dropping a block by yielding nothing produces no output for it", async () => {
		class DropOddStream extends UnbufferedTransformStream {
			override *_transform(block: Block): Iterable<Block> {
				if ((block.samples[0]?.[0] ?? 0) % 2 === 0) yield block;
			}
		}

		const { context } = createTestStreamContext();
		const stream = new DropOddStream(nodeWith({}), context);
		const output = await drainBlocks(
			await stream.setup(readableFrom([createBlock(1, 0, 10), createBlock(2, 10, 10)]), createTestSetupContext()),
		);

		expect(output).toHaveLength(1);
		expect(output[0]?.samples[0]?.[0]).toBe(2);
	});
});

describe("UnbufferedTransformStream._flush", () => {
	it("yields trailing output after all blocks", async () => {
		const MARKER = -3;

		class TrailingStream extends UnbufferedTransformStream {
			flushCalls = 0;

			override *_transform(block: Block): Iterable<Block> {
				yield block;
			}

			override *_flush(): Iterable<Block> {
				this.flushCalls += 1;

				yield createBlock(MARKER, 0, 4);
			}
		}

		const { context } = createTestStreamContext();
		const stream = new TrailingStream(nodeWith({}), context);
		const output = await drainBlocks(
			await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext()),
		);

		expect(stream.flushCalls).toBe(1);
		expect(output.at(-1)?.samples[0]?.[0]).toBe(MARKER);
	});

	it("still fires once on empty upstream", async () => {
		class TrailingStream extends UnbufferedTransformStream {
			flushCalls = 0;

			override _transform(): Iterable<Block> {
				return [];
			}

			override _flush(): Iterable<Block> {
				this.flushCalls += 1;

				return [];
			}
		}

		const { context } = createTestStreamContext();
		const stream = new TrailingStream(nodeWith({}), context);

		await drainBlocks(await stream.setup(readableFrom([]), createTestSetupContext()));

		expect(stream.flushCalls).toBe(1);
	});
});

describe("UnbufferedTransformStream destroy", () => {
	it("runs _destroy once on graceful completion", async () => {
		class CountingStream extends GainStream {
			destroyCount = 0;

			override _destroy(): void {
				this.destroyCount += 1;
			}
		}

		const { context } = createTestStreamContext();
		const stream = new CountingStream(nodeWith({}), context);

		await drainBlocks(await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext()));

		expect(stream.destroyCount).toBe(1);
	});
});

describe("UnbufferedTransformStream pull-paced serving", () => {
	it("advances the transform generator only on consumer demand — reading one block bounds production", async () => {
		let yields = 0;

		class PacedStream extends UnbufferedTransformStream {
			override async *_transform(block: Block): AsyncIterable<Block> {
				for (let i = 0; i < 500; i += 1) {
					yields += 1;

					yield block;
				}
			}
		}

		const { context } = createTestStreamContext();
		const stream = new PacedStream(nodeWith({}), context);
		const output = await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext());
		const reader = output.getReader();

		const first = await reader.read();

		// Settle any eager draining: under correct pull-pacing the generator advances only to refill the
		// one-block queue and then blocks on consumer demand; a regressed loop that drains inside one pull
		// would run all 500 yields during this window.
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(first.done).toBe(false);
		expect(yields).toBeLessThanOrEqual(4);

		await reader.cancel("done");
	});

	it("cancelling the output reader runs the generator's finally and destroys once", async () => {
		let finallyRan = false;

		class CancelStream extends UnbufferedTransformStream {
			destroyCount = 0;

			override async *_transform(block: Block): AsyncIterable<Block> {
				try {
					for (let i = 0; i < 1000; i += 1) yield block;
				} finally {
					finallyRan = true;
				}
			}

			override _destroy(): void {
				this.destroyCount += 1;
			}
		}

		const { context } = createTestStreamContext();
		const stream = new CancelStream(nodeWith({}), context);
		const output = await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext());
		const reader = output.getReader();

		await reader.read();
		await reader.cancel("stop");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(finallyRan).toBe(true);
		expect(stream.destroyCount).toBe(1);
	});
});

function openInput(blocks: Array<Block>): {
	readonly readable: ReadableStream<Block>;
	readonly cancelled: () => boolean;
} {
	let cancelled = false;
	const readable = new ReadableStream<Block>({
		start: (controller) => {
			for (const block of blocks) controller.enqueue(block);
		},
		cancel: () => {
			cancelled = true;
		},
	});

	return { readable, cancelled: () => cancelled };
}

// Lets the output's prefetch pull advance the generator onto its next input read before the test cancels.
function parkOnInput(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

class LifecycleStream extends GainStream {
	flushCalls = 0;
	destroyCount = 0;

	override _flush(): Iterable<Block> {
		this.flushCalls += 1;

		return [];
	}

	override _destroy(): void {
		this.destroyCount += 1;
	}
}

describe("UnbufferedTransformStream cancellation", () => {
	it("resolves a cancel while parked on an input that never closes, skipping _flush and completion", async () => {
		const { context, events } = createTestStreamContext();
		const finished = vi.fn();

		events.on("finished", finished);

		const stream = new LifecycleStream(nodeWith({}), context);
		const input = openInput([createBlock(1, 0, 10)]);
		const reader = (await stream.setup(input.readable, createTestSetupContext())).getReader();

		expect((await reader.read()).value?.samples[0]?.[0]).toBe(2);

		await parkOnInput();
		await reader.cancel();

		expect(input.cancelled()).toBe(true);
		expect(stream.flushCalls).toBe(0);
		expect(stream.destroyCount).toBe(1);
		expect(finished).not.toHaveBeenCalled();
	});

	it("cancels a stream driven through _setup() and _pipe() without setup()", async () => {
		const { context } = createTestStreamContext();
		const stream = new LifecycleStream(nodeWith({}), context);
		const input = openInput([createBlock(1, 0, 10)]);

		stream._setup(createTestSetupContext());

		const reader = stream._pipe(input.readable).getReader();

		await reader.read();
		await parkOnInput();
		await reader.cancel();

		expect(input.cancelled()).toBe(true);
		expect(stream.destroyCount).toBe(1);
	});

	it("errors with the render signal's reason when the render aborts", async () => {
		const { context } = createTestStreamContext();
		const stream = new LifecycleStream(nodeWith({}), context);
		const input = openInput([]);
		const controller = new AbortController();
		const reader = (
			await stream.setup(input.readable, createTestSetupContext({ signal: controller.signal }))
		).getReader();
		const pending = reader.read();

		controller.abort(new Error("render failed"));

		await expect(pending).rejects.toThrow("render failed");
		expect(input.cancelled()).toBe(true);
		expect(stream.flushCalls).toBe(0);
		expect(stream.destroyCount).toBe(1);
	});

	it("errors instead of completing when the render aborts during _flush", async () => {
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});

		class ParkedFlushStream extends GainStream {
			flushing = false;

			// eslint-disable-next-line require-yield
			override async *_flush(): AsyncIterable<Block> {
				this.flushing = true;

				await parked;
			}
		}

		const { context, events } = createTestStreamContext();
		const finished = vi.fn();

		events.on("finished", finished);

		const stream = new ParkedFlushStream(nodeWith({}), context);
		const controller = new AbortController();
		const reader = (
			await stream.setup(readableFrom([]), createTestSetupContext({ signal: controller.signal }))
		).getReader();
		const pending = reader.read();

		await vi.waitFor(() => expect(stream.flushing).toBe(true));

		controller.abort(new Error("render failed"));
		release?.();

		await expect(pending).rejects.toThrow("render failed");
		expect(finished).not.toHaveBeenCalled();
	});

	it("resolves a cancel that reaches a composed upstream only after that upstream's teardown", async () => {
		const log: Array<string> = [];

		class SlowStream extends UnbufferedTransformStream {
			private calls = 0;

			override async *_transform(block: Block): AsyncGenerator<Block> {
				this.calls += 1;

				if (this.calls === 2) {
					await new Promise((resolve) => setTimeout(resolve, 200));
					log.push("upstream call ends");
				}

				yield block;
			}

			override _destroy(): void {
				log.push("upstream _destroy");
			}
		}

		const { context } = createTestStreamContext();
		const upstream = new SlowStream(nodeWith({}), context);
		const downstream = new GainStream(nodeWith({}), context);

		upstream._setup(createTestSetupContext());
		downstream._setup(createTestSetupContext());

		// Driven like silero-vad's analysis reader: no render job, only a reader that cancels.
		const input = openInput([createBlock(1, 0, 10), createBlock(2, 10, 10), createBlock(3, 20, 10)]);
		const reader = downstream._pipe(upstream._pipe(input.readable)).getReader();

		await reader.read();
		await parkOnInput();
		await reader.cancel();
		log.push("cancel resolved");

		expect(log).toEqual(["upstream call ends", "upstream _destroy", "cancel resolved"]);
	});

	it("cancels its input when _transform throws", async () => {
		class ThrowingStream extends UnbufferedTransformStream {
			override _transform(): Iterable<Block> {
				throw new Error("transform failed");
			}
		}

		const { context } = createTestStreamContext();
		const stream = new ThrowingStream(nodeWith({}), context);
		const input = openInput([createBlock(1, 0, 10)]);
		const reader = (await stream.setup(input.readable, createTestSetupContext())).getReader();

		await expect(reader.read()).rejects.toThrow("transform failed");
		expect(input.cancelled()).toBe(true);
	});
});

describe("UnbufferedTransformStream progress shape", () => {
	it("emits buffer/emit progress with monotonic framesDone, completions at true totals, createdAt present", async () => {
		const { context, events } = createTestStreamContext();
		const stream = new GainStream(nodeWith({}), context);
		const progress = collectProgress(events);

		await drainBlocks(
			await stream.setup(
				readableFrom([createBlock(1, 0, 100), createBlock(2, 100, 100)]),
				createTestSetupContext({ sourceTotalFrames: 200 }),
			),
		);

		const buffers = progress.filter((p) => p.phase === "buffer");
		const emits = progress.filter((p) => p.phase === "emit");
		const emitFrames = emits.map((p) => p.framesDone);

		expect(buffers.length).toBeGreaterThanOrEqual(1);
		expect(emits.length).toBeGreaterThanOrEqual(1);
		expect(progress.every((p) => typeof p.createdAt === "number")).toBe(true);
		expect(buffers.at(-1)?.framesDone).toBe(200);
		expect(emits.at(-1)?.framesDone).toBe(200);
		expect(emitFrames).toEqual([...emitFrames].sort((a, b) => a - b));
	});
});
