import { linearToDb } from "@buffered-audio/utils";
import { describe, expect, it } from "vitest";
import { measureFrameTruePeakDb } from "./objective";

const SAMPLE_RATE = 48_000;

describe("measureFrameTruePeakDb", () => {
	// Happy-path correctness with a KNOWN answer. DC has no intersample
	// structure for the polyphase upsampler to lift, so the 4× true peak
	// of a steady-0.5 frame is ≈ 0.5 linear (≈ -6.02 dBTP), within the
	// upsampler leading-edge ramp tolerance. Picking DC keeps the
	// expected value independent of the AA-filter design — the test
	// pins THIS function's contract (push → finalize → linearToDb), not
	// the upsampler's filter shape.
	it("returns ≈ -6 dBTP for a steady 0.5 DC frame", () => {
		const frame = new Float32Array(2048).fill(0.5);

		const resultDb = measureFrameTruePeakDb([frame], SAMPLE_RATE);

		expect(resultDb).toBeGreaterThan(linearToDb(0.4));
		expect(resultDb).toBeLessThan(linearToDb(0.6));
	});

	it("returns the linearToDb silence floor for an all-zero frame", () => {
		const silent = new Float32Array(2048);

		expect(measureFrameTruePeakDb([silent], SAMPLE_RATE)).toBe(linearToDb(0));
	});

	it("returns the linearToDb silence floor for zero channels", () => {
		expect(measureFrameTruePeakDb([], SAMPLE_RATE)).toBe(linearToDb(0));
	});

	it("handles an empty (zero-length) frame without throwing", () => {
		const empty = new Float32Array(0);

		expect(measureFrameTruePeakDb([empty], SAMPLE_RATE)).toBe(linearToDb(0));
	});

	// The load-bearing isolation property for the never-worsen
	// comparison: a loud frame measured first must NOT raise the
	// measured peak of a quiet frame measured second. If a single
	// accumulator leaked across calls (12-tap history bleed OR the
	// running-max never decreasing), the second result would be pulled
	// up toward the first. We assert the second call equals the same
	// quiet frame measured in complete isolation.
	it("successive calls do not contaminate each other", () => {
		const loud = new Float32Array(2048).fill(0.9);
		const quiet = new Float32Array(2048).fill(0.01);

		const quietAlone = measureFrameTruePeakDb([quiet], SAMPLE_RATE);

		const loudResult = measureFrameTruePeakDb([loud], SAMPLE_RATE);
		const quietAfterLoud = measureFrameTruePeakDb([quiet], SAMPLE_RATE);

		// The loud frame really is louder (sanity that the inputs differ).
		expect(loudResult).toBeGreaterThan(quietAfterLoud);
		// The quiet measurement is identical whether or not a loud frame
		// preceded it — no cross-call state.
		expect(quietAfterLoud).toBe(quietAlone);
	});
});
