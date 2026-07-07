import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { BlockBuffer } from "./block-buffer";
import { BufferedTransformStream, WHOLE_FILE } from "./buffered-transform";
import type { Block, BufferedAudioNode, NodeIdentity, StreamContext } from "./node";
import { DEFAULT_PROGRESS_QUANTUM, type ProgressPayload, type RenderEvents } from "./stream";

function createBlock(value: number, offset: number, frames: number): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate: 44100, bitDepth: 32 };
}

function nodeWith(properties: Record<string, unknown>): BufferedAudioNode {
	return { properties } as unknown as BufferedAudioNode;
}

function context(): StreamContext {
	return { executionProviders: ["cpu"], memoryLimit: 256 * 1024 * 1024, highWaterMark: 16 };
}

function contextWithDuration(durationFrames: number): StreamContext {
	return { executionProviders: ["cpu"], memoryLimit: 256 * 1024 * 1024, highWaterMark: 16, durationFrames };
}

const EMIT_IDENTITY: NodeIdentity = { nodeName: "probe-transform", id: "pt", type: ["buffered-audio-node", "transform", "probe"] };

function bindProgress(stream: BufferedTransformStream): Array<ProgressPayload> {
	const events: RenderEvents = new EventEmitter();
	const progress: Array<ProgressPayload> = [];

	events.on("progress", (_identity, payload) => progress.push(payload));
	stream.bind(events, EMIT_IDENTITY, DEFAULT_PROGRESS_QUANTUM);

	return progress;
}

function readableFrom(blocks: Array<Block>): ReadableStream<Block> {
	let index = 0;

	return new ReadableStream<Block>({
		pull: (controller) => {
			const block = blocks[index];

			if (block) {
				index += 1;
				controller.enqueue(block);
			} else {
				controller.close();
			}
		},
	});
}

async function drain(readable: ReadableStream<Block>): Promise<Array<Block>> {
	const out: Array<Block> = [];
	const reader = readable.getReader();

	for (;;) {
		const { done, value } = await reader.read();

		if (done) break;
		if (value) out.push(value);
	}

	return out;
}

class RecordingTransformStream extends BufferedTransformStream {
	readonly firings: Array<number> = [];

	override async transform(buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
		this.firings.push(buffered.frames);

		await super.transform(buffered, enqueue);
	}
}

describe("BufferedTransformStream block-mode firing", () => {
	it("block mode fires at exactly blockSize frames, then a trailing short block at end", async () => {
		const stream = new RecordingTransformStream(nodeWith({ blockSize: 64 }));
		const input = [createBlock(1, 0, 100), createBlock(2, 100, 50)];

		await drain(await stream._setup(readableFrom(input), context()));

		expect(stream.firings).toEqual([64, 64, 22]);
	});

	it("WHOLE_FILE fires once at end with the full buffer", async () => {
		const stream = new RecordingTransformStream(nodeWith({ blockSize: WHOLE_FILE }));
		const input = [createBlock(1, 0, 100), createBlock(2, 100, 100)];

		await drain(await stream._setup(readableFrom(input), context()));

		expect(stream.firings).toEqual([200]);
	});
});

describe("BufferedTransformStream default transform (drain identity)", () => {
	it("passes buffered audio through unchanged in WHOLE_FILE mode", async () => {
		const stream = new BufferedTransformStream(nodeWith({ blockSize: WHOLE_FILE, streamChunkSize: 50 }));
		const input = [createBlock(0.5, 0, 100)];

		const output = await drain(await stream._setup(readableFrom(input), context()));

		expect(output.reduce((sum, b) => sum + (b.samples[0]?.length ?? 0), 0)).toBe(100);
		expect(output.every((b) => b.samples[0]?.[0] === 0.5)).toBe(true);
	});
});

describe("BufferedTransformStream.prepare", () => {
	it("prepare modifies the block written to the buffer", async () => {
		class DoublingStream extends BufferedTransformStream {
			override prepare(block: Block): Block {
				return { ...block, samples: block.samples.map((channel) => channel.map((v) => v * 2)) };
			}
		}

		const stream = new DoublingStream(nodeWith({ blockSize: WHOLE_FILE }));
		const output = await drain(await stream._setup(readableFrom([createBlock(1, 0, 10)]), context()));

		expect(output[0]?.samples[0]?.[0]).toBe(2);
	});
});

describe("BufferedTransformStream.flush", () => {
	it("flush enqueues trailing output after the final transform firing", async () => {
		const MARKER = -7;

		class FlushingStream extends BufferedTransformStream {
			flushCalls = 0;

			override flush(enqueue: (block: Block) => void): void {
				this.flushCalls += 1;
				enqueue(createBlock(MARKER, 0, 4));
			}
		}

		const stream = new FlushingStream(nodeWith({ blockSize: WHOLE_FILE }));
		const output = await drain(await stream._setup(readableFrom([createBlock(1, 0, 10)]), context()));

		expect(stream.flushCalls).toBe(1);
		expect(output.at(-1)?.samples[0]?.[0]).toBe(MARKER);
	});
});

describe("BufferedTransformStream.blockSize validation", () => {
	it("throws when blockSize is 0", () => {
		expect(() => new BufferedTransformStream(nodeWith({ blockSize: 0 }))).toThrow(/blockSize/);
	});

	it("defaults to WHOLE_FILE when blockSize is absent", () => {
		const stream = new BufferedTransformStream(nodeWith({}));

		expect(stream.blockSize).toBe(WHOLE_FILE);
	});
});

describe("BufferedTransformStream enqueue re-slicing", () => {
	it("re-slices an oversized enqueued block into outputChunkSize pieces preserving offsets", async () => {
		class BigEnqueueStream extends BufferedTransformStream {
			override async transform(_buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
				await Promise.resolve();
				enqueue(createBlock(3, 1000, 250));
			}
		}

		const stream = new BigEnqueueStream(nodeWith({ blockSize: 64, streamChunkSize: 100 }));
		const output = await drain(await stream._setup(readableFrom([createBlock(1, 0, 64)]), context()));

		const bigPieces = output.filter((b) => b.samples[0]?.[0] === 3);

		expect(bigPieces.map((b) => b.samples[0]?.length)).toEqual([100, 100, 50]);
		expect(bigPieces.map((b) => b.offset)).toEqual([1000, 1100, 1200]);
	});
});

describe("BufferedTransformStream destroy", () => {
	it("closes the buffer and runs _destroy once on graceful flush", async () => {
		class CountingStream extends BufferedTransformStream {
			destroyCount = 0;

			override _destroy(): void {
				this.destroyCount += 1;
			}
		}

		const stream = new CountingStream(nodeWith({ blockSize: WHOLE_FILE }));

		await drain(await stream._setup(readableFrom([createBlock(1, 0, 10)]), context()));

		expect(stream.destroyCount).toBe(1);
	});

	it("runs destroy once on downstream cancel", async () => {
		class CountingStream extends BufferedTransformStream {
			destroyCount = 0;

			override _destroy(): void {
				this.destroyCount += 1;
			}
		}

		const stream = new CountingStream(nodeWith({ blockSize: WHOLE_FILE }));
		const input = new ReadableStream<Block>({
			pull: (controller) => controller.enqueue(createBlock(1, 0, 10)),
		});

		const output = await stream._setup(input, context());
		const reader = output.getReader();

		await reader.cancel("stop");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(stream.destroyCount).toBe(1);
	});
});

describe("BufferedTransformStream emit-phase progress totals", () => {
	it("emit events carry framesTotal = sourceTotalFrames and stay quantum-bounded (known total)", async () => {
		const stream = new BufferedTransformStream(nodeWith({ blockSize: WHOLE_FILE, streamChunkSize: 10 }));
		const progress = bindProgress(stream);

		await drain(await stream.setup(readableFrom([createBlock(0.5, 0, 1000)]), contextWithDuration(1000)));

		const emits = progress.filter((p) => p.phase === "emit");

		expect(emits.length).toBeGreaterThanOrEqual(10);
		expect(emits.length).toBeLessThanOrEqual(13);
		expect(emits.every((p) => p.framesTotal === 1000)).toBe(true);
		expect(emits.at(-1)?.framesDone).toBe(1000);
	});

	it("unknown total falls back to the 480k constant — no per-chunk emit spam", async () => {
		const stream = new BufferedTransformStream(nodeWith({ blockSize: WHOLE_FILE, streamChunkSize: 10 }));
		const progress = bindProgress(stream);

		await drain(await stream.setup(readableFrom([createBlock(0.5, 0, 1000)]), context()));

		const emits = progress.filter((p) => p.phase === "emit");

		expect(emits.every((p) => p.framesTotal === undefined)).toBe(true);
		expect(emits.length).toBeLessThanOrEqual(3);
		expect(emits.at(-1)?.framesDone).toBe(1000);
	});

	it("the forced WHOLE_FILE process start renders a percentage (framesTotal set, framesDone 0)", async () => {
		const stream = new BufferedTransformStream(nodeWith({ blockSize: WHOLE_FILE, streamChunkSize: 10 }));
		const progress = bindProgress(stream);

		await drain(await stream.setup(readableFrom([createBlock(0.5, 0, 1000)]), contextWithDuration(1000)));

		const processStart = progress.find((p) => p.phase === "process" && p.framesDone === 0);

		expect(processStart?.framesTotal).toBe(1000);
	});
});
