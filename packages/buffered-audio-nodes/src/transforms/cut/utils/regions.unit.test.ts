import { describe, expect, it } from "vitest";
import { computeKeepRanges } from "./regions";

const SAMPLE_RATE = 1000;

describe("computeKeepRanges", () => {
	it("keeps the frames on either side of a mid-chunk cut region", () => {
		const ranges = computeKeepRanges([{ start: 0.2, end: 0.4 }], 0, SAMPLE_RATE, 1000);

		expect(ranges).toEqual([
			{ start: 0, end: 200 },
			{ start: 400, end: 1000 },
		]);
	});

	it("keeps the whole chunk when there are no regions", () => {
		expect(computeKeepRanges([], 0, SAMPLE_RATE, 1000)).toEqual([{ start: 0, end: 1000 }]);
	});

	it("returns no ranges when a region covers the entire chunk", () => {
		expect(computeKeepRanges([{ start: 0, end: 1 }], 0, SAMPLE_RATE, 1000)).toEqual([]);
	});

	it("ignores regions that fall entirely outside the chunk", () => {
		const beforeChunk = computeKeepRanges([{ start: 0, end: 0.5 }], 1, SAMPLE_RATE, 1000);

		expect(beforeChunk).toEqual([{ start: 0, end: 1000 }]);
	});

	it("merges overlapping regions via the advancing cursor", () => {
		const ranges = computeKeepRanges(
			[
				{ start: 0.1, end: 0.3 },
				{ start: 0.2, end: 0.5 },
			],
			0,
			SAMPLE_RATE,
			1000,
		);

		expect(ranges).toEqual([
			{ start: 0, end: 100 },
			{ start: 500, end: 1000 },
		]);
	});

	it("returns an empty list for an empty chunk", () => {
		expect(computeKeepRanges([], 0, SAMPLE_RATE, 0)).toEqual([]);
	});
});
