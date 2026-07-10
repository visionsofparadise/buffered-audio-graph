import { describe, expect, it } from "vitest";
import { silenceChunkSizes } from "./chunk-frames";

describe("silenceChunkSizes", () => {
	it("splits a total into full chunks with a smaller remainder last", () => {
		expect(silenceChunkSizes(250, 100)).toEqual([100, 100, 50]);
	});

	it("emits a single chunk when the total fits", () => {
		expect(silenceChunkSizes(40, 100)).toEqual([40]);
	});

	it("splits into exact chunks with no remainder", () => {
		expect(silenceChunkSizes(200, 100)).toEqual([100, 100]);
	});

	it("returns no chunks for a zero total", () => {
		expect(silenceChunkSizes(0, 100)).toEqual([]);
	});
});
