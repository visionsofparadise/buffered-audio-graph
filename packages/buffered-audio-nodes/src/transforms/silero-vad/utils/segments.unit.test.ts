import { describe, expect, it } from "vitest";
import { mapSegmentsToRate, padSegments, probabilitiesToSegments } from "./segments";

const windowFrames = 10;

function segmentsOf(
	values: Array<number>,
	options?: {
		readonly threshold?: number;
		readonly minSpeechFrames?: number;
		readonly minSilenceFrames?: number;
		readonly totalFrames?: number;
	},
) {
	const probabilities = Float32Array.from(values);

	return probabilitiesToSegments(probabilities, {
		threshold: options?.threshold ?? 0.5,
		minSpeechFrames: options?.minSpeechFrames ?? 10,
		minSilenceFrames: options?.minSilenceFrames ?? 10,
		windowFrames,
		totalFrames: options?.totalFrames ?? values.length * windowFrames,
	});
}

describe("probabilitiesToSegments", () => {
	it("stamps onset at the window-start sample", () => {
		expect(segmentsOf([0, 0, 0.9, 0.9, 0.9, 0, 0, 0])).toEqual([{ start: 20, end: 50 }]);
	});

	it("closes at silence start after hangover", () => {
		expect(
			segmentsOf([0.9, 0.9, 0.9, 0, 0, 0, 0], { minSilenceFrames: 20 }),
		).toEqual([{ start: 0, end: 30 }]);
	});

	it("holds through the hysteresis band", () => {
		expect(segmentsOf([0.9, 0.4, 0.9, 0.1, 0.1, 0.1])).toEqual([{ start: 0, end: 30 }]);
	});

	it("discards regions shorter than min speech", () => {
		expect(segmentsOf([0, 0.9, 0, 0, 0], { minSpeechFrames: 20 })).toEqual([]);
	});

	it("continues a region when silence is shorter than min silence", () => {
		expect(
			segmentsOf([0.9, 0.9, 0.1, 0.9, 0.9, 0.1, 0.1, 0.1], { minSilenceFrames: 20 }),
		).toEqual([{ start: 0, end: 50 }]);
	});

	it("closes a trailing region at end-of-audio", () => {
		expect(segmentsOf([0, 0.9, 0.9, 0.9], { totalFrames: 40 })).toEqual([{ start: 10, end: 40 }]);
	});

	it("returns no segments for empty input", () => {
		expect(segmentsOf([])).toEqual([]);
	});

	it("returns a single region for all-speech input", () => {
		expect(segmentsOf([0.9, 0.9, 0.9], { totalFrames: 30 })).toEqual([{ start: 0, end: 30 }]);
	});

	it("floors negativeThreshold at 0.01", () => {
		expect(
			segmentsOf([0.2, 0.005, 0, 0], { threshold: 0.1, minSpeechFrames: 5 }),
		).toEqual([{ start: 0, end: 10 }]);
	});
});

describe("padSegments", () => {
	it("clamps first-start and last-end padding", () => {
		expect(padSegments([{ start: 5, end: 20 }], 10, 30)).toEqual([{ start: 0, end: 30 }]);
	});

	it("splits a gap narrower than 2 × padFrames evenly", () => {
		expect(
			padSegments(
				[
					{ start: 0, end: 10 },
					{ start: 20, end: 30 },
				],
				8,
				40,
			),
		).toEqual([
			{ start: 0, end: 15 },
			{ start: 15, end: 38 },
		]);
	});

	it("applies full pad on both sides when the gap is wide enough", () => {
		expect(
			padSegments(
				[
					{ start: 20, end: 40 },
					{ start: 80, end: 90 },
				],
				10,
				120,
			),
		).toEqual([
			{ start: 10, end: 50 },
			{ start: 70, end: 100 },
		]);
	});

	it("returns empty input unchanged", () => {
		expect(padSegments([], 10, 100)).toEqual([]);
	});
});

describe("mapSegmentsToRate", () => {
	it("scales by the rate ratio and rounds", () => {
		expect(mapSegmentsToRate([{ start: 10, end: 20 }], 16000, 48000, 100)).toEqual([
			{ start: 30, end: 60 },
		]);
	});

	it("clamps to [0, totalFrames]", () => {
		expect(mapSegmentsToRate([{ start: 0, end: 100 }], 1, 10, 50)).toEqual([{ start: 0, end: 50 }]);
	});

	it("drops inverted and empty mapped segments", () => {
		expect(
			mapSegmentsToRate(
				[
					{ start: 5, end: 5 },
					{ start: 20, end: 10 },
					{ start: 1, end: 2 },
				],
				1,
				1,
				100,
			),
		).toEqual([{ start: 1, end: 2 }]);
	});

	it("is identity when rates match", () => {
		expect(mapSegmentsToRate([{ start: 7, end: 21 }], 16000, 16000, 100)).toEqual([
			{ start: 7, end: 21 },
		]);
	});
});
