import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BufferedTransformStream, UnbufferedTransformStream, TransformNode, type Block, type BlockBuffer, type BufferedAudioNode, type StreamRenderContext } from "@buffered-audio/core";
import { read } from "../sources/read";
import { write } from "../targets/write";
import { readWavSamples } from "../utils/read-to-buffer";
import { audio } from "../utils/test-binaries";

const testVoice = audio.testVoice;

class PassthroughStream extends UnbufferedTransformStream {
	override *_transform(block: Block): Generator<Block> {
		yield block;
	}
}

class PassthroughTransform extends TransformNode {
	static override readonly nodeName = "Passthrough";
	static override readonly packageName = "test";
	static override readonly Stream = PassthroughStream;
}

class ErrorStream extends BufferedTransformStream {
	override async *_transform(_buffered: BlockBuffer): AsyncGenerator<Block> {
		await Promise.resolve();

		throw new Error("Intentional transform error");
	}
}

class ErrorTransform extends TransformNode {
	static override readonly nodeName = "Error";
	static override readonly packageName = "test";
	static override readonly Stream = ErrorStream;
}

class ScaleStream extends UnbufferedTransformStream {
	constructor(
		node: BufferedAudioNode,
		context: StreamRenderContext,
		private readonly factor: number,
	) {
		super(node, context);
	}

	override *_transform(block: Block): Generator<Block> {
		const scaled = block.samples.map((channel) => {
			const out = new Float32Array(channel.length);
			for (let i = 0; i < channel.length; i++) {
				out[i] = channel[i]! * this.factor;
			}
			return out;
		});
		yield { ...block, samples: scaled };
	}
}

class CompositeStream extends UnbufferedTransformStream {
	private readonly first: ScaleStream;
	private readonly second: ScaleStream;

	constructor(node: BufferedAudioNode, context: StreamRenderContext) {
		super(node, context);
		this.first = new ScaleStream(this.node, context, 2);
		this.second = new ScaleStream(this.node, context, 0.5);
	}

	override *_transform(block: Block): Generator<Block> {
		yield block;
	}

	override _pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		return this.second._pipe(super._pipe(this.first._pipe(input)));
	}
}

class CompositeTransform extends TransformNode {
	static override readonly nodeName = "Composite";
	static override readonly packageName = "test";
	static override readonly Stream = CompositeStream;
}

describe("TransformNode lifecycle", () => {
	it("renders the same pipeline twice with correct output both times", async () => {
		const tempOut = join(tmpdir(), `ban-multi-render-${randomBytes(8).toString("hex")}.wav`);
		const original = await readWavSamples(testVoice);

		try {
			const source = read(testVoice);
			const transform = new PassthroughTransform();
			const target = write(tempOut, { bitDepth: "32f" });

			source.to(transform);
			transform.to(target);

			await source.createRenderJob().render();

			const result1 = await readWavSamples(tempOut);
			expect(result1.sampleRate).toBe(original.sampleRate);
			expect(result1.durationFrames).toBe(original.durationFrames);

			await source.createRenderJob().render();

			const result2 = await readWavSamples(tempOut);
			expect(result2.sampleRate).toBe(original.sampleRate);
			expect(result2.durationFrames).toBe(original.durationFrames);

			const compareLength = Math.min(1000, original.durationFrames);
			const origCh0 = original.samples[0]!;
			const result2Ch0 = result2.samples[0]!;

			for (let i = 0; i < compareLength; i++) {
				expect(result2Ch0[i]).toBeCloseTo(origCh0[i]!, 4);
			}
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	}, 240_000);

	it("propagates errors from transform without hanging", async () => {
		const tempOut = join(tmpdir(), `ban-error-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = read(testVoice);
			const transform = new ErrorTransform();
			const target = write(tempOut, { bitDepth: "32f" });

			source.to(transform);
			transform.to(target);

			await expect(source.createRenderJob().render()).rejects.toThrow("Intentional transform error");
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	}, 240_000);
});

describe("Composite stream via _setup()", () => {
	it("chains internal transforms and produces correct output", async () => {
		const tempOut = join(tmpdir(), `ban-composite-${randomBytes(8).toString("hex")}.wav`);
		const original = await readWavSamples(testVoice);

		try {
			const source = read(testVoice);
			const composite = new CompositeTransform();
			const target = write(tempOut, { bitDepth: "32f" });

			source.to(composite);
			composite.to(target);
			await source.createRenderJob().render();

			const result = await readWavSamples(tempOut);
			expect(result.sampleRate).toBe(original.sampleRate);
			expect(result.durationFrames).toBe(original.durationFrames);

			const compareLength = Math.min(1000, original.durationFrames);
			const origCh0 = original.samples[0]!;
			const resultCh0 = result.samples[0]!;

			for (let i = 0; i < compareLength; i++) {
				expect(resultCh0[i]).toBeCloseTo(origCh0[i]!, 4);
			}
		} finally {
			await unlink(tempOut).catch(() => undefined);
		}
	}, 240_000);
});
