import { describe, expect, it } from "vitest";
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
		const output = await drainBlocks(await stream.setup(readableFrom([createBlock(1, 0, 10), createBlock(2, 10, 10)]), createTestSetupContext()));

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
		const output = await drainBlocks(await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext()));

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

describe("UnbufferedTransformStream progress shape", () => {
	it("emits buffer/emit progress with monotonic framesDone, completions at true totals, createdAt present", async () => {
		const { context, events } = createTestStreamContext();
		const stream = new GainStream(nodeWith({}), context);
		const progress = collectProgress(events);

		await drainBlocks(await stream.setup(readableFrom([createBlock(1, 0, 100), createBlock(2, 100, 100)]), createTestSetupContext({ durationFrames: 200 })));

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
