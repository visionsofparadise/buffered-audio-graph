import { describe, expect, it } from "vitest";
import { BlockSumAccumulator } from "./block-sum";

describe("BlockSumAccumulator", () => {
	it("constant 1.0 input, blockSize=400, blockStep=100, frames=1000 → 7 closed blocks of sum 400", () => {
		const accumulator = new BlockSumAccumulator(400, 100);
		const input = new Float64Array(1000);

		input.fill(1);

		accumulator.push(input, 1000);

		const closed = accumulator.finalize();

		// Closed-block count = floor((1000 - 400) / 100) + 1 = 7.
		expect(closed.length).toBe(7);

		for (const sum of closed) {
			expect(sum).toBe(400);
		}
	});

	it("blockSize == blockStep → block sums equal disjoint sample-window sums", () => {
		const accumulator = new BlockSumAccumulator(100, 100);
		const input = new Float64Array(500);

		// Deterministic non-constant signal so disjoint windows produce different sums.
		for (let i = 0; i < 500; i++) {
			input[i] = i;
		}

		accumulator.push(input, 500);

		const closed = accumulator.finalize();

		// 5 disjoint 100-sample windows, sums 0..99, 100..199, ...
		expect(closed.length).toBe(5);

		for (let blockIndex = 0; blockIndex < 5; blockIndex++) {
			let expected = 0;

			for (let i = blockIndex * 100; i < (blockIndex + 1) * 100; i++) expected += i;

			expect(closed[blockIndex]).toBe(expected);
		}
	});

	it("chunked push parity: same total signal in one push vs N pushes → same finalize() output", () => {
		const total = 4096;
		const input = new Float64Array(total);

		for (let i = 0; i < total; i++) input[i] = Math.sin(0.01 * i);

		const oneShot = new BlockSumAccumulator(400, 100);

		oneShot.push(input, total);

		const oneShotClosed = oneShot.finalize();

		const streamed = new BlockSumAccumulator(400, 100);
		const chunkSize = 333; // misaligned to both blockSize and blockStep

		for (let offset = 0; offset < total; offset += chunkSize) {
			const frames = Math.min(chunkSize, total - offset);
			const slice = input.subarray(offset, offset + frames);

			streamed.push(slice, frames);
		}

		const streamedClosed = streamed.finalize();

		expect(streamedClosed.length).toBe(oneShotClosed.length);

		for (let i = 0; i < oneShotClosed.length; i++) {
			expect(streamedClosed[i]).toBeCloseTo(oneShotClosed[i] ?? 0, 12);
		}
	});

	it("empty input → finalize() returns empty array", () => {
		const accumulator = new BlockSumAccumulator(400, 100);

		expect(accumulator.finalize()).toEqual([]);
	});

	it("re-finalize is idempotent", () => {
		const accumulator = new BlockSumAccumulator(100, 100);
		const input = new Float64Array(300);

		input.fill(2);
		accumulator.push(input, 300);

		const first = accumulator.finalize();
		const second = accumulator.finalize();

		expect(second).toBe(first);
	});

	it("push after finalize throws", () => {
		const accumulator = new BlockSumAccumulator(100, 100);

		accumulator.finalize();

		expect(() => accumulator.push(new Float64Array(10), 10)).toThrow(/finalize/);
	});

	it("constructor: non-positive blockSize throws", () => {
		expect(() => new BlockSumAccumulator(0, 100)).toThrow(/blockSize/);
	});

	it("constructor: non-positive blockStep throws", () => {
		expect(() => new BlockSumAccumulator(400, 0)).toThrow(/blockStep/);
	});

});
