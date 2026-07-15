import { describe, expect, it } from "vitest";
import { interleave, deinterleaveBuffer } from "./interleave";

function float32ToBuffer(data: Float32Array): Buffer {
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

describe("interleave / deinterleaveBuffer", () => {
	it("round-trips stereo data", () => {
		const left = new Float32Array([1, 2, 3, 4]);
		const right = new Float32Array([5, 6, 7, 8]);
		const frames = 4;
		const channels = 2;

		const interleaved = interleave([left, right], frames, channels);
		const result = deinterleaveBuffer(float32ToBuffer(interleaved), channels);

		expect(result).toHaveLength(2);
		expect(Array.from(result[0]!)).toEqual([1, 2, 3, 4]);
		expect(Array.from(result[1]!)).toEqual([5, 6, 7, 8]);
	});

	it("round-trips mono data", () => {
		const mono = new Float32Array([10, 20, 30]);
		const interleaved = interleave([mono], 3, 1);
		const result = deinterleaveBuffer(float32ToBuffer(interleaved), 1);

		expect(result).toHaveLength(1);
		expect(Array.from(result[0]!)).toEqual([10, 20, 30]);
	});

	it("produces correct stereo interleaved layout [L0, R0, L1, R1, ...]", () => {
		const left = new Float32Array([1, 2, 3]);
		const right = new Float32Array([4, 5, 6]);

		const interleaved = interleave([left, right], 3, 2);

		expect(Array.from(interleaved)).toEqual([1, 4, 2, 5, 3, 6]);
	});

	it("handles empty input (0 frames)", () => {
		const interleaved = interleave([], 0, 2);
		expect(interleaved).toHaveLength(0);

		const result = deinterleaveBuffer(float32ToBuffer(new Float32Array(0)), 2);
		expect(result).toHaveLength(2);
		expect(result[0]!).toHaveLength(0);
		expect(result[1]!).toHaveLength(0);
	});

	it("mono interleave is identity", () => {
		const mono = new Float32Array([7, 8, 9]);
		const interleaved = interleave([mono], 3, 1);

		expect(Array.from(interleaved)).toEqual([7, 8, 9]);
	});
});
