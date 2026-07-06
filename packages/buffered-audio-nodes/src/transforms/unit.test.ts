import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BufferedAudioNodeProperties, type BlockBuffer, type StreamContext } from "@buffered-audio/core";
import { read } from "../sources/read";
import { write } from "../targets/write";
import { readWavSamples } from "../utils/read-to-buffer";
import { audio } from "../utils/test-binaries";

const testVoice = audio.testVoice;

class PassthroughTransform extends TransformNode {
	static override readonly nodeName = "Passthrough";
	static override readonly packageName = "test";
	override readonly type = ["buffered-audio-node", "transform", "passthrough"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	override createStream(): BufferedTransformStream {
		return new BufferedTransformStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	clone(overrides?: Partial<BufferedAudioNodeProperties>): PassthroughTransform {
		return new PassthroughTransform({ ...this.properties, ...overrides });
	}
}

class ErrorStream extends BufferedTransformStream {
	override async _process(_buffer: BlockBuffer): Promise<void> {
		throw new Error("Intentional _process error");
	}
}

class ErrorTransform extends TransformNode {
	static override readonly nodeName = "Error";
	static override readonly packageName = "test";
	override readonly type = ["buffered-audio-node", "transform", "error"] as const;
	get bufferSize(): number { return WHOLE_FILE; }
	get latency(): number { return 0; }

	override createStream(): ErrorStream {
		return new ErrorStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	clone(overrides?: Partial<BufferedAudioNodeProperties>): ErrorTransform {
		return new ErrorTransform({ ...this.properties, ...overrides });
	}
}

class ScaleStream extends BufferedTransformStream {
	private readonly factor: number;

	constructor(factor: number, properties: Record<string, unknown>) {
		super({ ...properties, bufferSize: 0, overlap: 0 });
		this.factor = factor;
	}

	override _unbuffer(chunk: Block): Block {
		const scaled = chunk.samples.map((channel) => {
			const out = new Float32Array(channel.length);
			for (let i = 0; i < channel.length; i++) {
				out[i] = channel[i]! * this.factor;
			}
			return out;
		});
		return { ...chunk, samples: scaled };
	}
}

class CompositeStream extends BufferedTransformStream {
	override async _setup(input: ReadableStream<Block>, _context: StreamContext): Promise<ReadableStream<Block>> {
		const first = new ScaleStream(2, {});
		const second = new ScaleStream(0.5, {});
		return input.pipeThrough(first.createTransformStream()).pipeThrough(second.createTransformStream());
	}
}

class CompositeTransform extends TransformNode {
	static override readonly nodeName = "Composite";
	static override readonly packageName = "test";
	override readonly type = ["buffered-audio-node", "transform", "composite"] as const;
	get bufferSize(): number { return 0; }
	get latency(): number { return 0; }

	override createStream(): CompositeStream {
		return new CompositeStream({ ...this.properties, bufferSize: 0, overlap: 0 });
	}

	clone(overrides?: Partial<BufferedAudioNodeProperties>): CompositeTransform {
		return new CompositeTransform({ ...this.properties, ...overrides });
	}
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

			await source.render();

			const result1 = await readWavSamples(tempOut);
			expect(result1.sampleRate).toBe(original.sampleRate);
			expect(result1.durationFrames).toBe(original.durationFrames);

			await source.render();

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

	it("propagates errors from _process without hanging", async () => {
		const tempOut = join(tmpdir(), `ban-error-${randomBytes(8).toString("hex")}.wav`);

		try {
			const source = read(testVoice);
			const transform = new ErrorTransform();
			const target = write(tempOut, { bitDepth: "32f" });

			source.to(transform);
			transform.to(target);

			await expect(source.render()).rejects.toThrow("Intentional _process error");
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
			await source.render();

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
