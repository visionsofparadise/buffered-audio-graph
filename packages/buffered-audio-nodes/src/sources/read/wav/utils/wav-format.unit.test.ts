import { describe, it, expect } from "vitest";
import { readSample } from "./wav-format";

describe("readSample", () => {
	// One case per bit depth / format: the type-coercion boundary where PCM ints/floats become normalized samples.
	it("decodes 16-bit signed PCM to [-1, 1)", () => {
		const buffer = Buffer.alloc(2);

		buffer.writeInt16LE(16384, 0); // 0x4000 = half of 0x8000

		expect(readSample(buffer, 0, 16, 1)).toBeCloseTo(0.5, 6);
	});

	it("decodes 16-bit full-scale negative to exactly -1", () => {
		const buffer = Buffer.alloc(2);

		buffer.writeInt16LE(-32768, 0);

		expect(readSample(buffer, 0, 16, 1)).toBe(-1);
	});

	it("decodes 24-bit signed PCM (little-endian 3-byte)", () => {
		const positive = Buffer.from([0x00, 0x00, 0x40]); // 0x400000 = half of 0x800000
		const negative = Buffer.from([0x00, 0x00, 0x80]); // 0x800000 → -1 after sign extension

		expect(readSample(positive, 0, 24, 1)).toBeCloseTo(0.5, 6);
		expect(readSample(negative, 0, 24, 1)).toBe(-1);
	});

	it("decodes 32-bit signed PCM", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeInt32LE(0x40000000, 0); // half of 0x80000000

		expect(readSample(buffer, 0, 32, 1)).toBeCloseTo(0.5, 6);
	});

	it("decodes 32-bit IEEE float (audioFormat 3)", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeFloatLE(0.25, 0);

		expect(readSample(buffer, 0, 32, 3)).toBe(0.25);
	});

	it("decodes 64-bit IEEE float (audioFormat 3)", () => {
		const buffer = Buffer.alloc(8);

		buffer.writeDoubleLE(0.75, 0);

		expect(readSample(buffer, 0, 64, 3)).toBe(0.75);
	});

	it("decodes 8-bit unsigned PCM (128 = silence)", () => {
		const buffer = Buffer.from([192]); // (192 - 128) / 128 = 0.5

		expect(readSample(buffer, 0, 8, 1)).toBeCloseTo(0.5, 6);
	});

	it("honours the byte offset", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeInt16LE(0, 0);
		buffer.writeInt16LE(-32768, 2);

		expect(readSample(buffer, 2, 16, 1)).toBe(-1);
	});

	// Unsupported depth/format returns 0 rather than NaN.
	it("returns 0 for an unsupported bit depth", () => {
		const buffer = Buffer.alloc(4);

		expect(readSample(buffer, 0, 12, 1)).toBe(0);
	});
});
