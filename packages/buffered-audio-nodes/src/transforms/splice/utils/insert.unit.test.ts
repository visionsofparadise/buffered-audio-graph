import { describe, expect, it } from "vitest";
import { applyInsert, computeInsertOverlap } from "./insert";

describe("computeInsertOverlap", () => {
	it("computes the overlap for an insert fully inside the chunk", () => {
		expect(computeInsertOverlap(0, 100, 20, 40)).toEqual({ overlapStart: 20, overlapEnd: 60, insertOffset: 0 });
	});

	it("returns undefined when the chunk ends before the insert starts", () => {
		expect(computeInsertOverlap(0, 100, 200, 50)).toBeUndefined();
	});

	it("returns undefined when the chunk starts after the insert ends", () => {
		expect(computeInsertOverlap(300, 100, 0, 100)).toBeUndefined();
	});

	it("carries an insert offset when the chunk starts partway through the insert", () => {
		expect(computeInsertOverlap(80, 100, 50, 100)).toEqual({ overlapStart: 0, overlapEnd: 70, insertOffset: 30 });
	});

	it("covers the whole chunk when the insert spans it exactly", () => {
		expect(computeInsertOverlap(0, 100, 0, 100)).toEqual({ overlapStart: 0, overlapEnd: 100, insertOffset: 0 });
	});
});

describe("applyInsert", () => {
	it("overwrites the overlap region from the insert channel", () => {
		const dest = new Float32Array([0, 0, 0, 0]);

		applyInsert(dest, new Float32Array([9, 9, 9]), { overlapStart: 1, overlapEnd: 3, insertOffset: 0 });

		expect(Array.from(dest)).toEqual([0, 9, 9, 0]);
	});

	it("reads from the insert offset", () => {
		const dest = new Float32Array([0, 0]);

		applyInsert(dest, new Float32Array([1, 2, 3, 4]), { overlapStart: 0, overlapEnd: 2, insertOffset: 2 });

		expect(Array.from(dest)).toEqual([3, 4]);
	});

	it("leaves samples untouched when the insert channel runs out", () => {
		const dest = new Float32Array([5, 5, 5]);

		applyInsert(dest, new Float32Array([7]), { overlapStart: 0, overlapEnd: 3, insertOffset: 0 });

		expect(Array.from(dest)).toEqual([7, 5, 5]);
	});
});
