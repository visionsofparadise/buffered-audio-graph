import { describe, expect, it } from "vitest";
import { SlidingWindowMaxStream, slidingWindowMax } from "./sliding-window-max";

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
		// Mix a slow sine envelope with random noise so the running
		// window-max has plenty of variation across the array (otherwise
		// a uniform-amplitude noise fixture's deque stays nearly empty).
		const envelope = 0.4 + 0.5 * Math.sin((2 * Math.PI * frameIdx) / 137);
		const noise = rand();

		result[frameIdx] = envelope * noise;
	}

	return result;
}

/**
 * Reference: a naive O(N · W) sliding-window max. Used to cross-check
 * the deque-based {@link slidingWindowMax} on small fixtures so a deque
 * bug doesn't get masked by the streaming variant matching the same
 * buggy reference.
 */
function slidingWindowMaxNaive(input: Float32Array, halfWidth: number): Float32Array {
	const length = input.length;
	const output = new Float32Array(length);

	for (let outputIdx = 0; outputIdx < length; outputIdx++) {
		const leftEdge = Math.max(0, outputIdx - halfWidth);
		const rightEdge = Math.min(length - 1, outputIdx + halfWidth);
		let max = -Infinity;

		for (let windowIdx = leftEdge; windowIdx <= rightEdge; windowIdx++) {
			const value = input[windowIdx] ?? 0;

			if (value > max) max = value;
		}

		output[outputIdx] = max;
	}

	return output;
}

/**
 * Run the streaming form by splitting `input` into successive chunks of
 * size `chunkSize` and concatenating the per-chunk outputs. The final
 * chunk is signalled with `isFinal = true`.
 */
function runStreaming(input: Float32Array, halfWidth: number, chunkSize: number): Float32Array {
	const stream = new SlidingWindowMaxStream(halfWidth);
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

describe("slidingWindowMax (whole-array)", () => {
	it("matches the naive reference on a small fixture", () => {
		const input = makeFixture(257, 0xdead_beef);
		const halfWidth = 12;
		const expected = slidingWindowMaxNaive(input, halfWidth);
		const actual = slidingWindowMax(input, halfWidth);

		expect(actual.length).toBe(input.length);
		for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
			expect(actual[frameIdx]).toBe(expected[frameIdx]);
		}
	});

	it("returns an empty array on empty input", () => {
		const result = slidingWindowMax(new Float32Array(0), 5);

		expect(result.length).toBe(0);
	});

	it("halfWidth = 0 returns the input bit-for-bit (window = single sample)", () => {
		const input = makeFixture(50, 0xc0ffee);
		const result = slidingWindowMax(input, 0);

		for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
			expect(result[frameIdx]).toBe(input[frameIdx]);
		}
	});
});

describe("SlidingWindowMaxStream (chunked)", () => {
	it("byte-equivalent to whole-array reference at chunk size 100", () => {
		const input = makeFixture(5000, 0xface_f00d);
		const halfWidth = 50;
		const reference = slidingWindowMax(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 100);

		expect(streamed.length).toBe(reference.length);
		for (let frameIdx = 0; frameIdx < reference.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("byte-equivalent to whole-array reference at chunk size 333 (non-aligned with halfWidth)", () => {
		const input = makeFixture(5000, 0x1234_5678);
		const halfWidth = 50;
		const reference = slidingWindowMax(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 333);

		expect(streamed.length).toBe(reference.length);
		for (let frameIdx = 0; frameIdx < reference.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("byte-equivalent to whole-array reference at chunk size 1000", () => {
		const input = makeFixture(5000, 0xabcd_1234);
		const halfWidth = 50;
		const reference = slidingWindowMax(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 1000);

		expect(streamed.length).toBe(reference.length);
		for (let frameIdx = 0; frameIdx < reference.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("byte-equivalent at chunk size 1 (every input → single-sample push)", () => {
		const input = makeFixture(500, 0x5a5a_f00d);
		const halfWidth = 17;
		const reference = slidingWindowMax(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 1);

		for (let frameIdx = 0; frameIdx < reference.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("halfWidth = 0 streaming output equals input bit-for-bit", () => {
		const input = makeFixture(200, 0xbadc_afe);
		const streamed = runStreaming(input, 0, 33);

		for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(input[frameIdx]);
		}
	});

	it("source shorter than halfWidth still emits all outputs once isFinal is signalled", () => {
		const input = makeFixture(10, 0xcafe_babe);
		const halfWidth = 50;
		const reference = slidingWindowMax(input, halfWidth);
		const streamed = runStreaming(input, halfWidth, 4);

		expect(streamed.length).toBe(input.length);
		for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
			expect(streamed[frameIdx]).toBe(reference[frameIdx]);
		}
	});

	it("empty input with isFinal returns an empty output (no crash)", () => {
		const stream = new SlidingWindowMaxStream(5);
		const result = stream.push(new Float32Array(0), true);

		expect(result.length).toBe(0);
	});
});
