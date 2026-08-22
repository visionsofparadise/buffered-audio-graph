import { describe, expect, it } from "vitest";
import { GateGain } from "./gate-gain";

const floorGain = 0.25;

function raisedCosineGain(fromGain: number, toGain: number, t: number): number {
	const mixed = 0.5 * (1 - Math.cos(Math.PI * t));

	return fromGain + (toGain - fromGain) * mixed;
}

function fillAll(
	segments: Array<{ readonly start: number; readonly end: number }>,
	frames: number,
	options?: { readonly attackFrames?: number; readonly releaseFrames?: number; readonly startFrame?: number },
): Float32Array {
	const gain = new Float32Array(frames);
	const gate = new GateGain(segments, {
		attackFrames: options?.attackFrames ?? 10,
		releaseFrames: options?.releaseFrames ?? 10,
		floorGain,
	});

	gate.fill(gain, options?.startFrame ?? 0);

	return gain;
}

describe("GateGain", () => {
	it("is unity inside padded segments and floor outside", () => {
		const gain = fillAll([{ start: 100, end: 200 }], 300);

		expect(gain[150]).toBe(1);
		expect(gain[199]).toBe(1);
		expect(gain[0]).toBe(floorGain);
		expect(gain[250]).toBe(floorGain);
	});

	it("matches raised-cosine values at fade endpoints and midpoints", () => {
		const attackFrames = 10;
		const releaseFrames = 10;
		const start = 100;
		const end = 200;
		const gain = fillAll([{ start, end }], 300, { attackFrames, releaseFrames });

		expect(gain[start]).toBe(1);
		expect(gain[start - attackFrames - 1]).toBe(floorGain);
		expect(gain[start - attackFrames]).toBeCloseTo(raisedCosineGain(floorGain, 1, 0), 6);
		expect(gain[start - attackFrames / 2]).toBeCloseTo((1 + floorGain) / 2, 6);

		expect(gain[end]).toBeCloseTo(raisedCosineGain(1, floorGain, 0), 6);
		expect(gain[end + releaseFrames]).toBeCloseTo(raisedCosineGain(1, floorGain, 1), 6);
		expect(gain[end + releaseFrames / 2]).toBeCloseTo((1 + floorGain) / 2, 6);
		expect(gain[end + releaseFrames + 1]).toBe(floorGain);
	});

	it("skips fades when attack and release are zero", () => {
		const gain = fillAll([{ start: 100, end: 200 }], 300, { attackFrames: 0, releaseFrames: 0 });

		expect(gain[99]).toBe(floorGain);
		expect(gain[100]).toBe(1);
		expect(gain[199]).toBe(1);
		expect(gain[200]).toBe(floorGain);
	});

	it("merges overlapping fades by taking the maximum gain", () => {
		const attackFrames = 20;
		const releaseFrames = 20;
		const gain = fillAll(
			[
				{ start: 100, end: 200 },
				{ start: 210, end: 300 },
			],
			320,
			{ attackFrames, releaseFrames },
		);

		const frame = 200;
		const fadeOut = raisedCosineGain(1, floorGain, (frame - 200) / releaseFrames);
		const fadeIn = raisedCosineGain(floorGain, 1, (frame - (210 - attackFrames)) / attackFrames);

		expect(gain[frame]).toBeCloseTo(Math.max(fadeOut, fadeIn), 6);
		expect(fadeOut).toBeGreaterThan(fadeIn);
		expect(gain[frame]).toBeCloseTo(fadeOut, 6);
	});

	it("matches a single fill when fill is split across chunk boundaries", () => {
		const segments = [
			{ start: 40, end: 90 },
			{ start: 140, end: 180 },
		];
		const whole = fillAll(segments, 220);
		const gate = new GateGain(segments, { attackFrames: 10, releaseFrames: 10, floorGain });
		const first = new Float32Array(70);
		const second = new Float32Array(80);
		const third = new Float32Array(70);

		gate.fill(first, 0);
		gate.fill(second, 70);
		gate.fill(third, 150);

		expect(Array.from(first)).toEqual(Array.from(whole.subarray(0, 70)));
		expect(Array.from(second)).toEqual(Array.from(whole.subarray(70, 150)));
		expect(Array.from(third)).toEqual(Array.from(whole.subarray(150)));
	});

	it("applies floor everywhere when there are no segments", () => {
		const gain = fillAll([], 16);

		expect(Array.from(gain).every((value) => value === floorGain)).toBe(true);
	});
});
