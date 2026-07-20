import { describe, expect, it } from "vitest";
import { BlockBuffer } from "@buffered-audio/core";
import { TruePeakUpsampler, linearToDb } from "@buffered-audio/utils";
import { TruePeakArgmaxAccumulator, streamLatticeTrajectory } from "./windowed";

function peakAbs(signal: Float32Array): number {
	let peak = 0;

	for (const value of signal) peak = Math.max(peak, Math.abs(value));

	return peak;
}

describe("TruePeakArgmaxAccumulator", () => {
	it("includes a flushed FIR-tail maximum and maps it to the last real input sample", () => {
		const input = new Float32Array([
			-0.08388812094926834,
			0.6030386090278625,
			-0.7042242288589478,
		]);
		const sourceAlignedPeak = peakAbs(new TruePeakUpsampler(4).upsample(input));
		const accumulator = new TruePeakArgmaxAccumulator(1, 48_000);

		accumulator.push([input], input.length);

		const result = accumulator.finalize();

		expect(result.db).toBeGreaterThan(linearToDb(sourceAlignedPeak));
		expect(result.db).toBeCloseTo(linearToDb(0.7503057227), 5);
		expect(result.peakInputSample).toBe(input.length - 1);
	});

	it("routes a tail-only maximum to the last analyzed frame under the Item-7 gate", async () => {
		const sampleRate = 48_000;
		const frameSize = 64;
		const hopSize = 32;
		const signal = new Float32Array(96);

		signal.set([
			-0.08388812094926834,
			0.6030386090278625,
			-0.7042242288589478,
		], signal.length - 3);

		const accumulator = new TruePeakArgmaxAccumulator(1, sampleRate);

		accumulator.push([signal], signal.length);

		const globalTruePeak = accumulator.finalize();
		const sourceAlignedPeak = peakAbs(new TruePeakUpsampler(4).upsample(signal));
		const buffer = new BlockBuffer();

		expect(globalTruePeak.db).toBeGreaterThan(linearToDb(sourceAlignedPeak));

		await buffer.write([signal], sampleRate, 32);
		await buffer.flushWrites();

		try {
			const result = await streamLatticeTrajectory(buffer, frameSize, hopSize, undefined, undefined, {
				globalTruePeakDb: globalTruePeak.db + 10,
				peakInputSample: globalTruePeak.peakInputSample,
				sampleRate,
				lambda: 0,
			});

			expect(result.frameCount).toBe(2);
			expect(result.bindingMask).toEqual([false, true]);
		} finally {
			await buffer.close();
		}
	});
});
