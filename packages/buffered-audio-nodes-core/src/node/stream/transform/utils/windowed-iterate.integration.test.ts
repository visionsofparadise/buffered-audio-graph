import { describe, expect, it } from "vitest";
import { BlockBuffer } from "./block-buffer";
import { windowedIterate } from "./windowed-iterate";

describe("windowedIterate", () => {
	it("yields windows at hopSize stride covering the buffer", async () => {
		const buffer = new BlockBuffer();
		const total = 100;
		const data = new Float32Array(total);
		for (let i = 0; i < total; i++) data[i] = i;
		await buffer.write([data], 44100, 32);
		await buffer.flushWrites();
		await buffer.reset();

		const windowSize = 20;
		const hopSize = 5;
		const observed: Array<Array<number>> = [];

		await windowedIterate(buffer, { windowSize, hopSize }, (window, _index) => {
			observed.push(Array.from(window[0]!));
		});

		const expectedFullWindowCount = Math.floor((total - windowSize) / hopSize) + 1;
		expect(observed.length).toBeGreaterThanOrEqual(expectedFullWindowCount);

		for (let w = 0; w < expectedFullWindowCount; w++) {
			const start = w * hopSize;
			const expected = Array.from({ length: windowSize }, (_, i) => start + i);
			expect(observed[w]).toEqual(expected);
		}

		await buffer.close();
	});

	it("yields a final partial window at end-of-buffer with zero padding", async () => {
		const buffer = new BlockBuffer();
		const total = 13;
		const data = new Float32Array(total);
		for (let i = 0; i < total; i++) data[i] = i + 1;
		await buffer.write([data], 44100, 32);
		await buffer.flushWrites();
		await buffer.reset();

		const windowSize = 8;
		const hopSize = 4;
		const observed: Array<Array<number>> = [];

		await windowedIterate(buffer, { windowSize, hopSize }, (window) => {
			observed.push(Array.from(window[0]!));
		});

		expect(observed.length).toBeGreaterThan(0);
		const last = observed[observed.length - 1]!;
		const nonZero = last.filter((v) => v !== 0).length;
		expect(nonZero).toBeLessThan(windowSize);
		expect(nonZero).toBeGreaterThan(0);

		await buffer.close();
	});
});
