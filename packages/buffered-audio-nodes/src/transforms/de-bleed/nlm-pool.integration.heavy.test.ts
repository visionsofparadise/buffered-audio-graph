/* eslint-disable @typescript-eslint/no-non-null-assertion -- typed-array access in test assertions */
import { describe, expect, it } from "vitest";
import { applyNlmSmoothing, type NlmParams } from "@buffered-audio/utils";
import { createNlmWorkerPool } from "./nlm-worker-pool";

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;

	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("nlm worker pool parity", () => {
	it("produces byte-identical output to the in-thread kernel in real worker mode (4 threads)", async () => {
		const numFrames = 200;
		const numBins = 129;
		const length = numFrames * numBins;

		const options: NlmParams = {
			patchSize: 8,
			searchFreqRadius: 8,
			searchTimePre: 16,
			searchTimePost: 4,
			pasteBlockSize: 8,
			threshold: 0.75,
		};

		const random = mulberry32(0x1234abcd);
		const maskData = new Float32Array(length);

		for (let i = 0; i < length; i++) maskData[i] = random();

		const expected = new Float32Array(length);

		applyNlmSmoothing(maskData, numFrames, numBins, options, expected);

		const mask = new Float32Array(new SharedArrayBuffer(length * 4));

		mask.set(maskData);

		const output = new Float32Array(new SharedArrayBuffer(length * 4));

		const workerUrl = new URL("../../../dist/nlm-worker.js", import.meta.url);
		const pool = createNlmWorkerPool(4, workerUrl);

		expect(pool.mode).toBe("worker");

		try {
			await pool.run(mask, output, numFrames, numBins, options);
		} finally {
			await pool.close();
		}

		let maxDiff = 0;

		for (let i = 0; i < length; i++) {
			const diff = Math.abs(expected[i]! - output[i]!);

			if (diff > maxDiff) maxDiff = diff;
		}

		expect(maxDiff).toBe(0);
	});
});
