/* eslint-disable @typescript-eslint/no-non-null-assertion -- indexing test fixtures with known bounds */
import { describe, it, expect } from "vitest";
import { computeLogBandMappings, computeMelBandMappings, erbToFreq, freqToErb, freqToMel, melToFreq } from "./frequency";

describe("mel / erb conversions", () => {
	it("round-trips mel", () => {
		expect(melToFreq(freqToMel(1000))).toBeCloseTo(1000, 3);
		expect(freqToMel(0)).toBe(0);
	});

	it("round-trips erb", () => {
		expect(erbToFreq(freqToErb(1000))).toBeCloseTo(1000, 3);
		expect(freqToErb(0)).toBe(0);
	});
});

describe("band mappings", () => {
	const sampleRate = 44100;
	const fftSize = 2048;
	const numLinearBins = fftSize / 2 + 1;

	// The .bin band layout must stay inside the linear-bin range with well-formed edge weights.
	function assertWellFormed(mappings: ReadonlyArray<{ binStart: number; binEnd: number; weightStart: number; weightEnd: number }>, numBands: number): void {
		expect(mappings.length).toBe(numBands);

		for (const mapping of mappings) {
			expect(mapping.binStart).toBeGreaterThanOrEqual(0);
			expect(mapping.binEnd).toBeLessThanOrEqual(numLinearBins - 1);
			expect(mapping.binEnd).toBeGreaterThanOrEqual(mapping.binStart);
			expect(mapping.weightStart).toBeGreaterThanOrEqual(0);
			expect(mapping.weightStart).toBeLessThanOrEqual(1);
			expect(mapping.weightEnd).toBeGreaterThanOrEqual(0);
			expect(mapping.weightEnd).toBeLessThanOrEqual(1);
		}
	}

	it("produces well-formed log-scale band mappings that ascend in frequency", () => {
		const mappings = computeLogBandMappings(16, 20, 20000, sampleRate, fftSize);

		assertWellFormed(mappings, 16);
		// Log scale climbs: later bands start at higher bins.
		expect(mappings[15]!.binStart).toBeGreaterThan(mappings[0]!.binStart);
	});

	it("produces well-formed mel-scale band mappings", () => {
		assertWellFormed(computeMelBandMappings(32, 20, 20000, sampleRate, fftSize), 32);
	});
});
