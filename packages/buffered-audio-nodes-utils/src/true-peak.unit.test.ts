import { describe, expect, it } from "vitest";
import { TruePeakAccumulator } from "./true-peak";

function generateSine(frequency: number, amplitude: number, sampleRate: number, durationSeconds: number): Float32Array {
	const length = Math.floor(sampleRate * durationSeconds);
	const buffer = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		buffer[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
	}

	return buffer;
}

function measure(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const accumulator = new TruePeakAccumulator(sampleRate, channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return accumulator.finalize();
}

describe("TruePeakAccumulator", () => {
	// DC has no intersample structure, so upsampled max should match the input amplitude (within filter-startup transient); catches a bug that would scale/invert the input.
	it("DC at 0.5 returns true peak ≈ 0.5 (no intersample lift)", () => {
		const sampleRate = 48000;
		const length = sampleRate; // 1 s
		const dc = new Float32Array(length);

		for (let i = 0; i < length; i++) dc[i] = 0.5;

		const result = measure([dc], sampleRate);

		// Modest tolerance for filter ramp-up at the leading edge.
		expect(result).toBeGreaterThan(0.4);
		expect(result).toBeLessThan(0.6);
	});

	// A 1 kHz sine at 0 dBFS sample peak should yield upsampled true peak ≥ 1.0; tests SHAPE (≥ sample peak) not the precise value (depends on AA filter design).
	it("0 dBFS sine: true peak is at least the sample peak", () => {
		const sampleRate = 48000;
		// 997 Hz at 48 kHz has non-integer samples-per-cycle, exposing intersample peak lift; amplitude 1.0 = 0 dBFS sample peak.
		const sine = generateSine(997, 1.0, sampleRate, 1);
		const result = measure([sine], sampleRate);

		expect(result).toBeGreaterThanOrEqual(1.0 - 1e-3);
	});

	it("silence returns 0", () => {
		const sampleRate = 48000;
		const silence = new Float32Array(sampleRate);
		const result = measure([silence], sampleRate);

		expect(result).toBe(0);
	});

	// Multi-channel true peak is a single max across ALL channels; per-channel tracking returning channel 0 would give 0.3 not 0.7.
	it("multi-channel max is single value across channels", () => {
		const sampleRate = 48000;
		const length = sampleRate;
		const left = new Float32Array(length);
		const right = new Float32Array(length);

		for (let i = 0; i < length; i++) {
			left[i] = 0.3;
			right[i] = 0.7;
		}

		const result = measure([left, right], sampleRate);

		expect(result).toBeGreaterThan(0.6);
		expect(result).toBeLessThan(0.8);
	});

	// Streaming-equivalence catches biquad-state drift across push() boundaries.
	it("chunked input matches whole-buffer input", () => {
		const sampleRate = 48000;
		const sine = generateSine(997, 0.8, sampleRate, 1);
		const oneShot = measure([sine], sampleRate);

		const chunked = new TruePeakAccumulator(sampleRate, 1);
		const chunkFrames = 4096;

		for (let offset = 0; offset < sine.length; offset += chunkFrames) {
			const frames = Math.min(chunkFrames, sine.length - offset);
			const slice = sine.subarray(offset, offset + frames);

			chunked.push([slice], frames);
		}

		const streamed = chunked.finalize();

		expect(Math.abs(streamed - oneShot)).toBeLessThan(1e-6);
	});

	it("re-finalize is idempotent: second call returns the same value", () => {
		const sampleRate = 48000;
		const sine = generateSine(997, 0.8, sampleRate, 1);
		const accumulator = new TruePeakAccumulator(sampleRate, 1);

		accumulator.push([sine], sine.length);

		const first = accumulator.finalize();
		const second = accumulator.finalize();

		expect(second).toBe(first);
	});

	it("empty input (no push) returns 0", () => {
		const accumulator = new TruePeakAccumulator(48000, 1);

		expect(accumulator.finalize()).toBe(0);
	});

	it("push with zero frames is a no-op", () => {
		const accumulator = new TruePeakAccumulator(48000, 1);

		accumulator.push([new Float32Array(0)], 0);

		expect(accumulator.finalize()).toBe(0);
	});
});
