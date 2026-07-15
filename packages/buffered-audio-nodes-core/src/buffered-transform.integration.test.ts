import { describe, expect, it } from "vitest";
import type { Block, BlockBuffer } from "./block-buffer";
import { BufferedTransformStream, WHOLE_FILE } from "./buffered-transform";
import type { BufferedAudioNode } from "./node";
import type { ProgressPayload, RenderEvents } from "./stream";
import { createBlock, createTestSetupContext, createTestStreamContext, drainBlocks, readableFrom } from "./testing";

function nodeWith(properties: Record<string, unknown>): BufferedAudioNode {
	return { properties, constructor: { nodeName: "probe-transform" } } as unknown as BufferedAudioNode;
}

function collectProgress(events: RenderEvents): Array<ProgressPayload> {
	const out: Array<ProgressPayload> = [];

	events.on("progress", (_identity, payload) => out.push(payload));

	return out;
}

class RecordingTransformStream extends BufferedTransformStream {
	readonly firings: Array<number> = [];

	override async *_transform(buffered: BlockBuffer): AsyncIterable<Block> {
		this.firings.push(buffered.frames);

		yield* super._transform(buffered);
	}
}

class IdentityTransformStream extends BufferedTransformStream {}

describe("BufferedTransformStream block-mode firing", () => {
	it("block mode fires at exactly blockSize frames, then a trailing short block at end", async () => {
		const { context } = createTestStreamContext();
		const stream = new RecordingTransformStream(nodeWith({ blockSize: 64 }), context);
		const input = [createBlock(1, 0, 100), createBlock(2, 100, 50)];

		await drainBlocks(await stream.setup(readableFrom(input), createTestSetupContext()));

		expect(stream.firings).toEqual([64, 64, 22]);
	});

	it("WHOLE_FILE fires once at end with the full buffer", async () => {
		const { context } = createTestStreamContext();
		const stream = new RecordingTransformStream(nodeWith({ blockSize: WHOLE_FILE }), context);
		const input = [createBlock(1, 0, 100), createBlock(2, 100, 100)];

		await drainBlocks(await stream.setup(readableFrom(input), createTestSetupContext()));

		expect(stream.firings).toEqual([200]);
	});
});

describe("BufferedTransformStream default transform (drain identity)", () => {
	it("passes buffered audio through unchanged in WHOLE_FILE mode", async () => {
		const { context } = createTestStreamContext();
		const stream = new IdentityTransformStream(nodeWith({ blockSize: WHOLE_FILE, streamChunkSize: 50 }), context);
		const input = [createBlock(0.5, 0, 100)];

		const output = await drainBlocks(await stream.setup(readableFrom(input), createTestSetupContext()));

		expect(output.reduce((sum, b) => sum + (b.samples[0]?.length ?? 0), 0)).toBe(100);
		expect(output.every((b) => b.samples[0]?.[0] === 0.5)).toBe(true);
	});
});

describe("BufferedTransformStream._prepare", () => {
	it("applies to blocks written to the buffer", async () => {
		class DoublingStream extends BufferedTransformStream {
			override _prepare(block: Block): Block {
				return { ...block, samples: block.samples.map((channel) => channel.map((v) => v * 2)) };
			}
		}

		const { context } = createTestStreamContext();
		const stream = new DoublingStream(nodeWith({ blockSize: WHOLE_FILE }), context);
		const output = await drainBlocks(await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext()));

		expect(output[0]?.samples[0]?.[0]).toBe(2);
	});
});

describe("BufferedTransformStream._flush", () => {
	it("yields trailing output after the final transform batch", async () => {
		const MARKER = -7;

		class FlushingStream extends BufferedTransformStream {
			flushCalls = 0;

			override *_flush(): Iterable<Block> {
				this.flushCalls += 1;

				yield createBlock(MARKER, 0, 4);
			}
		}

		const { context } = createTestStreamContext();
		const stream = new FlushingStream(nodeWith({ blockSize: WHOLE_FILE }), context);
		const output = await drainBlocks(await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext()));

		expect(stream.flushCalls).toBe(1);
		expect(output.at(-1)?.samples[0]?.[0]).toBe(MARKER);
	});
});

describe("BufferedTransformStream.blockSize validation", () => {
	it("throws when blockSize is 0", () => {
		const { context } = createTestStreamContext();

		expect(() => new IdentityTransformStream(nodeWith({ blockSize: 0 }), context)).toThrow(/blockSize/);
	});

	it("defaults to WHOLE_FILE when blockSize is absent", () => {
		const { context } = createTestStreamContext();
		const stream = new IdentityTransformStream(nodeWith({}), context);

		expect(stream.blockSize).toBe(WHOLE_FILE);
	});
});

describe("BufferedTransformStream oversized-yield re-slicing", () => {
	it("re-slices a yielded block larger than outputChunkSize into pieces preserving offsets", async () => {
		class BigYieldStream extends BufferedTransformStream {
			override async *_transform(): AsyncIterable<Block> {
				await Promise.resolve();

				yield createBlock(3, 1000, 250);
			}
		}

		const { context } = createTestStreamContext();
		const stream = new BigYieldStream(nodeWith({ blockSize: 64, streamChunkSize: 100 }), context);
		const output = await drainBlocks(await stream.setup(readableFrom([createBlock(1, 0, 64)]), createTestSetupContext()));

		const pieces = output.filter((b) => b.samples[0]?.[0] === 3);

		expect(pieces.map((b) => b.samples[0]?.length)).toEqual([100, 100, 50]);
		expect(pieces.map((b) => b.offset)).toEqual([1000, 1100, 1200]);
	});
});

describe("BufferedTransformStream destroy", () => {
	it("closes the buffer and runs _destroy once on graceful completion", async () => {
		class CountingStream extends BufferedTransformStream {
			destroyCount = 0;

			override _destroy(): void {
				this.destroyCount += 1;
			}
		}

		const { context } = createTestStreamContext();
		const stream = new CountingStream(nodeWith({ blockSize: WHOLE_FILE }), context);

		await drainBlocks(await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext()));

		expect(stream.destroyCount).toBe(1);
	});
});

describe("BufferedTransformStream pull-paced serving", () => {
	it("advances the transform generator only on consumer demand — reading one block bounds production", async () => {
		let yields = 0;

		class PacedStream extends BufferedTransformStream {
			override async *_transform(): AsyncIterable<Block> {
				for (let i = 0; i < 500; i += 1) {
					yields += 1;

					yield createBlock(i, i, 1);
				}
			}
		}

		const { context } = createTestStreamContext();
		const stream = new PacedStream(nodeWith({ blockSize: WHOLE_FILE }), context);
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

		class CancelStream extends BufferedTransformStream {
			destroyCount = 0;

			override async *_transform(): AsyncIterable<Block> {
				try {
					for (let i = 0; i < 1000; i += 1) yield createBlock(i, i, 4);
				} finally {
					finallyRan = true;
				}
			}

			override _destroy(): void {
				this.destroyCount += 1;
			}
		}

		const { context } = createTestStreamContext();
		const stream = new CancelStream(nodeWith({ blockSize: WHOLE_FILE }), context);
		const output = await stream.setup(readableFrom([createBlock(1, 0, 10)]), createTestSetupContext());
		const reader = output.getReader();

		await reader.read();
		await reader.cancel("stop");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(finallyRan).toBe(true);
		expect(stream.destroyCount).toBe(1);
	});
});

describe("BufferedTransformStream progress shape", () => {
	it("emits buffer/emit progress with monotonic framesDone, completions at true totals, createdAt present", async () => {
		const { context, events } = createTestStreamContext();
		const stream = new IdentityTransformStream(nodeWith({ blockSize: WHOLE_FILE, streamChunkSize: 10 }), context);
		const progress = collectProgress(events);

		await drainBlocks(await stream.setup(readableFrom([createBlock(0.5, 0, 100)]), createTestSetupContext({ durationFrames: 100 })));

		const buffers = progress.filter((p) => p.phase === "buffer");
		const emits = progress.filter((p) => p.phase === "emit");
		const emitFrames = emits.map((p) => p.framesDone);

		expect(buffers.length).toBeGreaterThanOrEqual(1);
		expect(emits.length).toBeGreaterThanOrEqual(1);
		expect(progress.every((p) => typeof p.createdAt === "number")).toBe(true);
		expect(buffers.at(-1)?.framesDone).toBe(100);
		expect(emits.at(-1)?.framesDone).toBe(100);
		expect(buffers.every((p) => p.framesTotal === 100)).toBe(true);
		expect(emitFrames).toEqual([...emitFrames].sort((a, b) => a - b));
	});
});
