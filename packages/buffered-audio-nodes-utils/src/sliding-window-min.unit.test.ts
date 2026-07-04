import { describe, expect, it } from "vitest";
import { SlidingWindowMinStream, slidingWindowMin } from "./sliding-window-min";

/** LCG (numerical-recipes constants) for deterministic noise. */
function makeLcg(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

		return state / 0x80_00_00_00 - 1;
	};
}

function makeFixture(length: number, seed: number): Float32Array {
	const result = new Float32Array(length);
	const rand = makeLcg(seed);

	for (let frameIdx = 0; frameIdx < length; frameIdx++) {
		const envelope = 0.4 + 0.5 * Math.sin((2 * Math.PI * frameIdx) / 137);
		const noise = rand();

		result[frameIdx] = envelope * noise;
	}

	return result;
}

function slidingWindowMinNaive(input: Float32Array, halfWidth: number): Float32Array {
	const length = input.length;
	const output = new Float32Array(length);

	for (let outputIdx = 0; outputIdx < length; outputIdx++) {
		const leftEdge = Math.max(0, outputIdx - halfWidth);
		const rightEdge = Math.min(length - 1, outputIdx + halfWidth);
		let min = Infinity;

		for (let windowIdx = leftEdge; windowIdx <= rightEdge; windowIdx++) {
			const value = input[windowIdx] ?? 0;

			if (value < min) min = value;
		}

		output[outputIdx] = min;
	}

	return output;
}

function runStreaming(input: Float32Array, halfWidth: number, chunkSize: number): Float32Array {
	const stream = new SlidingWindowMinStream(halfWidth);
	const collected: Array<Float32Array> = [];
	let totalEmitted = 0;
	let cursor = 0;

	while (cursor < input.length) {
		const remaining = input.length - cursor;
		const take = Math.min(chunkSize, remaining);
		const chunk = input.subarray(cursor, cursor + take);
		const isFinal = cursor + take >= input.length;
		const piece = stream.push(chunk, isFinal);

		collected.push(piece);
		totalEmitted += piece.length;
		cursor += take;
	}

	const output = new Float32Array(totalEmitted);
	let writeOffset = 0;

	for (const piece of collected) {
		output.set(piece, writeOffset);
		writeOffset += piece.length;
	}

	return output;
}

describe("slidingWindowMin (whole-array)", () => {
	it("matches the naive reference on a small fixture", () => {
		const input = makeFixture(257, 0xDEAD_BEEF);
		const halfWidth = 12;
		const expected = slidingWindowMinNaive(input, halfWidth);
		const actual = slidingWindowMin(input, halfWidth);

		expect(actual.length).toBe(input.length);
		for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
			expect(actual[frameIdx]).toBe(expected[frameIdx]);
		}
	});

	it("returns an empty array on empty input", () => {
		const result = slidingWindowMin(new Float32Array(0), 5);

		expect(result.length).toBe(0);
	});

	it("halfWidth = 0 returns the input bit-for-bit (window = single sample)", () => {
		const input = makeFixture(50, 0xC0FFEE);
		const result = slidingWindowMin(input, 0);

		for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
			expect(result[frameIdx]).toBe(input[frameIdx]);
		}
	});

	it("spike-down in flat-high region: window-min equals spike value within halfWidth", () => {
		const length = 200;
		const halfWidth = 10;
		const input = new Float32Array(length);
		// Float32-representable spike value so the assertion compares stored-vs-stored without the Number→Float32 rounding that bit-flips `0.1`.
		const spike = Math.fround(0.1);

		input.fill(1.0);
		input[100] = spike;

		const result = slidingWindowMin(input, halfWidth);

		for (let frameIdx = 100 - halfWidth; frameIdx <= 100 + halfWidth; frameIdx++) {
			expect(result[frameIdx]).toBe(spike);
		}
		expect(result[100 - halfWidth - 1]).toBe(1.0);
		expect(result[100 + halfWidth + 1]).toBe(1.0);
	});
});

describe("SlidingWindowMinStream (chunked)", () => {
	it("byte-equivalent to whole-array reference at chunk size 100", () => {
		const input = makeFixture(5000, 0xFACE_F00D);
		const halfWidth = 50;
		const reference = slidingWindowMin(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 100);

		expect(streamed.length).toBe(reference.length);
		for (let frameIdx = 0; frameIdx < reference.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("byte-equivalent to whole-array reference at chunk size 333 (non-aligned with halfWidth)", () => {
		const input = makeFixture(5000, 0x1234_5678);
		const halfWidth = 50;
		const reference = slidingWindowMin(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 333);

		expect(streamed.length).toBe(reference.length);
		for (let frameIdx = 0; frameIdx < reference.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("byte-equivalent to whole-array reference at chunk size 1000", () => {
		const input = makeFixture(5000, 0xABCD_1234);
		const halfWidth = 50;
		const reference = slidingWindowMin(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 1000);

		expect(streamed.length).toBe(reference.length);
		for (let frameIdx = 0; frameIdx < reference.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("byte-equivalent at chunk size 1 (every input → single-sample push)", () => {
		const input = makeFixture(500, 0x5A5A_F00D);
		const halfWidth = 17;
		const reference = slidingWindowMin(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 1);

		for (let frameIdx = 0; frameIdx < reference.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("halfWidth = 0 streaming output equals input bit-for-bit", () => {
		const input = makeFixture(200, 0xBADC_AFE);
		const streamed = runStreaming(input, 0, 33);

		for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(input[frameIdx]);
		}
	});

	it("source shorter than halfWidth still emits all outputs once isFinal is signalled", () => {
		const input = makeFixture(10, 0xCAFE_BABE);
		const halfWidth = 50;
		const reference = slidingWindowMin(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 4);

		expect(streamed.length).toBe(input.length);
		for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("empty input with isFinal returns an empty output (no crash)", () => {
		const stream = new SlidingWindowMinStream(5);
		const result = stream.push(new Float32Array(0), true);

		expect(result.length).toBe(0);
	});
});
