import { describe, it, expect } from "vitest";
import { ChunkBuffer } from "@buffered-audio/core";
import { pan, PanNode } from ".";

function makeMonoChunk(value: number, frames = 256): { samples: [Float32Array]; offset: number; sampleRate: number; bitDepth: number } {
	return { samples: [new Float32Array(frames).fill(value)], offset: 0, sampleRate: 48000, bitDepth: 32 };
}

function makeStereoChunk(leftValue: number, rightValue: number, frames = 256): { samples: [Float32Array, Float32Array]; offset: number; sampleRate: number; bitDepth: number } {
	return { samples: [new Float32Array(frames).fill(leftValue), new Float32Array(frames).fill(rightValue)], offset: 0, sampleRate: 48000, bitDepth: 32 };
}

async function applyPan(node: ReturnType<typeof pan>, chunk: { samples: Array<Float32Array>; offset: number; sampleRate: number; bitDepth: number }) {
	const stream = node.createStream();
	const buffer = new ChunkBuffer();
	try {
		await stream._buffer(chunk, buffer);
		return stream._unbuffer(chunk);
	} finally {
		await buffer.close();
	}
}

describe("PanNode", () => {
	it("has correct static metadata", () => {
		expect(PanNode.moduleName).toBe("Pan");
	});

	it("schema defaults to 0 (center)", () => {
		const node = pan();
		expect(node.properties.pan).toBe(0);
	});

	describe("mono -> stereo panning", () => {
		it("produces 2 output channels from 1 input channel", async () => {
			const node = pan({ pan: 0 });
			const output = await applyPan(node, makeMonoChunk(1.0));
			expect(output.samples.length).toBe(2);
		});

		it("at center (pan=0) both channels have equal power (equal-power law)", async () => {
			const node = pan({ pan: 0 });
			const output = await applyPan(node, makeMonoChunk(1.0));
			const leftRms = output.samples[0]![0]!;
			const rightRms = output.samples[1]![0]!;
			expect(leftRms).toBeCloseTo(rightRms, 5);
			// cos(π/4) ≈ 0.7071
			expect(leftRms).toBeCloseTo(Math.SQRT2 / 2, 4);
		});

		it("at full left (pan=-1) all energy goes to left channel", async () => {
			const node = pan({ pan: -1 });
			const output = await applyPan(node, makeMonoChunk(1.0));
			expect(output.samples[0]![0]).toBeCloseTo(1.0, 5);
			expect(output.samples[1]![0]).toBeCloseTo(0.0, 5);
		});

		it("at full right (pan=1) all energy goes to right channel", async () => {
			const node = pan({ pan: 1 });
			const output = await applyPan(node, makeMonoChunk(1.0));
			expect(output.samples[0]![0]).toBeCloseTo(0.0, 5);
			expect(output.samples[1]![0]).toBeCloseTo(1.0, 5);
		});

		it("preserves constant power: L^2 + R^2 = input^2", async () => {
			for (const panValue of [-0.5, 0, 0.5]) {
				const node = pan({ pan: panValue });
				const output = await applyPan(node, makeMonoChunk(1.0));
				const leftSq = (output.samples[0]![0] ?? 0) ** 2;
				const rightSq = (output.samples[1]![0] ?? 0) ** 2;
				expect(leftSq + rightSq).toBeCloseTo(1.0, 5);
			}
		});
	});

	describe("stereo balance", () => {
		it("at center (pan=0) both channels have unity gain", async () => {
			const node = pan({ pan: 0 });
			const output = await applyPan(node, makeStereoChunk(1.0, 1.0));
			expect(output.samples.length).toBe(2);
			expect(output.samples[0]![0]).toBeCloseTo(1.0, 4);
			expect(output.samples[1]![0]).toBeCloseTo(1.0, 4);
		});

		it("at full left (pan=-1) left channel at unity, right channel silenced", async () => {
			const node = pan({ pan: -1 });
			const output = await applyPan(node, makeStereoChunk(0.8, 0.8));
			// leftScale = min(1, 1 - (-1)) = 1
			expect(output.samples[0]![0]).toBeCloseTo(0.8, 4);
			// rightScale = min(1, 1 + (-1)) = 0
			expect(output.samples[1]![0]).toBeCloseTo(0.0, 4);
		});

		it("at full right (pan=1) right channel at unity, left channel silenced", async () => {
			const node = pan({ pan: 1 });
			const output = await applyPan(node, makeStereoChunk(0.8, 0.8));
			// leftScale = min(1, 1 - 1) = 0
			expect(output.samples[0]![0]).toBeCloseTo(0.0, 4);
			// rightScale = min(1, 1 + 1) = 1
			expect(output.samples[1]![0]).toBeCloseTo(0.8, 4);
		});

		it("at partial right (pan=0.5) reduces left by half, right stays at unity", async () => {
			const node = pan({ pan: 0.5 });
			const output = await applyPan(node, makeStereoChunk(1.0, 1.0));
			// leftScale = min(1, 1 - 0.5) = 0.5
			expect(output.samples[0]![0]).toBeCloseTo(0.5, 4);
			// rightScale = min(1, 1 + 0.5) = 1 (clamped)
			expect(output.samples[1]![0]).toBeCloseTo(1.0, 4);
		});
	});

	describe("channel count validation", () => {
		it("throws when input has more than 2 channels", async () => {
			const node = pan({ pan: 0 });
			const stream = node.createStream();
			const chunk = {
				samples: [new Float32Array(256), new Float32Array(256), new Float32Array(256)],
				offset: 0,
				sampleRate: 48000,
				bitDepth: 32,
			};
			const buffer = new ChunkBuffer();
			try {
				await stream._buffer(chunk, buffer);
				expect(() => stream._unbuffer(chunk)).toThrow(/PanNode supports 1 or 2 channel inputs only/);
			} finally {
				await buffer.close();
			}
		});
	});
});
