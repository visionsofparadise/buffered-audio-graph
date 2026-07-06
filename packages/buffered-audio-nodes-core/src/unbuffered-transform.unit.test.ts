import { describe, expect, it } from "vitest";
import type { Block, BufferedAudioNode, StreamContext } from "./node";
import { UnbufferedTransformStream } from "./unbuffered-transform";

function createBlock(value: number, offset: number, frames: number): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate: 44100, bitDepth: 32 };
}

function nodeWith(properties: Record<string, unknown>): BufferedAudioNode {
	return { properties } as unknown as BufferedAudioNode;
}

function context(): StreamContext {
	return { executionProviders: ["cpu"], memoryLimit: 256 * 1024 * 1024, highWaterMark: 16 };
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

class GainStream extends UnbufferedTransformStream {
	override transform(block: Block, enqueue: (block: Block) => void): void {
		enqueue({ ...block, samples: block.samples.map((channel) => channel.map((v) => v * 2)) });
	}
}

describe("UnbufferedTransformStream.transform", () => {
	it("transforms each block in arrival order", async () => {
		const stream = new GainStream(nodeWith({}));
		const input = [createBlock(1, 0, 10), createBlock(2, 10, 10)];

		const output = await drain(await stream._setup(readableFrom(input), context()));

		expect(output.map((b) => b.samples[0]?.[0])).toEqual([2, 4]);
	});

	it("dropping a block by not enqueuing yields no output for it", async () => {
		class DropOddStream extends UnbufferedTransformStream {
			override transform(block: Block, enqueue: (block: Block) => void): void {
				if ((block.samples[0]?.[0] ?? 0) % 2 === 0) enqueue(block);
			}
		}

		const stream = new DropOddStream(nodeWith({}));
		const output = await drain(await stream._setup(readableFrom([createBlock(1, 0, 10), createBlock(2, 10, 10)]), context()));

		expect(output).toHaveLength(1);
		expect(output[0]?.samples[0]?.[0]).toBe(2);
	});
});

describe("UnbufferedTransformStream.flush", () => {
	it("flush enqueues trailing output after all blocks", async () => {
		const MARKER = -3;

		class TrailingStream extends UnbufferedTransformStream {
			flushCalls = 0;

			override transform(block: Block, enqueue: (block: Block) => void): void {
				enqueue(block);
			}

			override flush(enqueue: (block: Block) => void): void {
				this.flushCalls += 1;
				enqueue(createBlock(MARKER, 0, 4));
			}
		}

		const stream = new TrailingStream(nodeWith({}));
		const output = await drain(await stream._setup(readableFrom([createBlock(1, 0, 10)]), context()));

		expect(stream.flushCalls).toBe(1);
		expect(output.at(-1)?.samples[0]?.[0]).toBe(MARKER);
	});

	it("flush still fires once on empty upstream", async () => {
		class TrailingStream extends UnbufferedTransformStream {
			flushCalls = 0;

			override transform(): void {}

			override flush(): void {
				this.flushCalls += 1;
			}
		}

		const stream = new TrailingStream(nodeWith({}));

		await drain(await stream._setup(readableFrom([]), context()));

		expect(stream.flushCalls).toBe(1);
	});
});

describe("UnbufferedTransformStream destroy", () => {
	it("runs _destroy once on graceful flush", async () => {
		class CountingStream extends GainStream {
			destroyCount = 0;

			override _destroy(): void {
				this.destroyCount += 1;
			}
		}

		const stream = new CountingStream(nodeWith({}));

		await drain(await stream._setup(readableFrom([createBlock(1, 0, 10)]), context()));

		expect(stream.destroyCount).toBe(1);
	});

	it("runs destroy once on downstream cancel", async () => {
		class CountingStream extends GainStream {
			destroyCount = 0;

			override _destroy(): void {
				this.destroyCount += 1;
			}
		}

		const stream = new CountingStream(nodeWith({}));
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
