import { describe, expect, it } from "vitest";
import { smoothEnvelope } from "./envelope";

describe("smoothEnvelope", () => {
	it("preserves a constant signal", () => {
		const envelope = new Float32Array([5, 5, 5, 5, 5, 5, 5, 5]);
		smoothEnvelope(envelope, 3);

		for (let i = 0; i < envelope.length; i++) {
			expect(envelope[i]).toBeCloseTo(5, 6);
		}
	});

	it("smooths an impulse with known window size", () => {
		const envelope = new Float32Array(9);
		envelope[4] = 9;
		smoothEnvelope(envelope, 3);

		expect(envelope[3]!).toBeGreaterThan(0);
		expect(envelope[4]!).toBeGreaterThan(0);
		expect(envelope[5]!).toBeGreaterThan(0);
		expect(envelope[4]!).toBeGreaterThanOrEqual(envelope[3]!);
		expect(envelope[0]).toBeCloseTo(0, 6);
		expect(envelope[8]).toBeCloseTo(0, 6);
	});

	it("modifies the input array in-place", () => {
		const envelope = new Float32Array(8);
		envelope[4] = 10;
		const original = envelope;
		smoothEnvelope(envelope, 5);

		expect(envelope).toBe(original);
		expect(envelope[4]).not.toBe(10);
	});

	it("produces same result with or without a scratch buffer", () => {
		const data1 = new Float32Array([0, 0, 1, 0, 0, 0, 1, 0]);
		const data2 = Float32Array.from(data1);
		const scratch = new Float32Array(data1.length);

		smoothEnvelope(data1, 3);
		smoothEnvelope(data2, 3, scratch);

		for (let i = 0; i < data1.length; i++) {
			expect(data2[i]).toBeCloseTo(data1[i]!, 6);
		}
	});

	it("handles window larger than signal length without crashing", () => {
		const envelope = new Float32Array([1, 2, 3]);
		expect(() => smoothEnvelope(envelope, 100)).not.toThrow();

		for (let i = 0; i < envelope.length; i++) {
			expect(Number.isFinite(envelope[i])).toBe(true);
		}
	});

	it("handles empty input without crashing", () => {
		const envelope = new Float32Array(0);
		expect(() => smoothEnvelope(envelope, 5)).not.toThrow();
	});
});
