import { describe, expect, it } from "vitest";
import { TruePeakUpsampler } from "./true-peak-upsampler";

const PHASE_COEFFICIENTS: ReadonlyArray<ReadonlyArray<number>> = [
	[
		0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000,
		-0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750,
		0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500,
	],
	[
		-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250,
		-0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125,
		0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375,
	],
	[
		-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000,
		-0.2003173828125, 0.7797851562500, 0.4650878906250, -0.1665039062500,
		0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875,
	],
	[
		-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750,
		-0.1022949218750, 0.9721679687500, 0.1373291015625, -0.0594482421875,
		0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750,
	],
];
const PHASES = PHASE_COEFFICIENTS.length;
const TAPS = PHASE_COEFFICIENTS[0]?.length ?? 0;
const TAIL_POSITIONS = TAPS - 1;

function directConvolution(input: Float32Array, tailPositions = TAIL_POSITIONS): Float64Array {
	const positions = input.length + tailPositions;
	const output = new Float64Array(positions * PHASES);

	for (let position = 0; position < positions; position++) {
		for (let phase = 0; phase < PHASES; phase++) {
			const coefficients = PHASE_COEFFICIENTS[phase];
			let sum = 0;

			for (let tap = 0; tap < TAPS; tap++) {
				const inputIndex = position - tap;
				const sample = inputIndex >= 0 && inputIndex < input.length ? input[inputIndex] ?? 0 : 0;

				sum += (coefficients?.[tap] ?? 0) * sample;
			}

			output[position * PHASES + phase] = sum;
		}
	}

	return output;
}

function concatenate(parts: ReadonlyArray<Float32Array>): Float32Array {
	const length = parts.reduce((total, part) => total + part.length, 0);
	const output = new Float32Array(length);
	let offset = 0;

	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}

	return output;
}

function runFinite(input: Float32Array, splitPoints?: ReadonlyArray<number>): Float32Array {
	const upsampler = new TruePeakUpsampler(4);
	const parts: Array<Float32Array> = [];

	if (splitPoints === undefined) {
		parts.push(upsampler.upsample(input));
	} else {
		let offset = 0;

		for (const end of [...splitPoints, input.length]) {
			parts.push(upsampler.upsample(input.subarray(offset, end)));
			offset = end;
		}
	}

	parts.push(upsampler.flush());

	return concatenate(parts);
}

describe("TruePeakUpsampler", () => {
	it("emits the four published phase columns for an impulse, including the FIR tail", () => {
		const output = runFinite(new Float32Array([1]));

		expect(output.length).toBe(TAPS * PHASES);

		for (let tap = 0; tap < TAPS; tap++) {
			for (let phase = 0; phase < PHASES; phase++) {
				const actual = output[tap * PHASES + phase] ?? 0;
				const expected = PHASE_COEFFICIENTS[phase]?.[tap] ?? 0;

				expect(Math.abs(actual - expected)).toBeLessThan(1e-7);
			}
		}
	});

	it("matches a test-local direct convolution over arbitrary input and 11 trailing zeros", () => {
		const input = new Float32Array([0.25, -0.75, 0.125, 0.9, -0.33, 0.02, 0.5]);
		const actual = runFinite(input);
		const expected = directConvolution(input);
		let maxError = 0;

		for (let index = 0; index < actual.length; index++) {
			maxError = Math.max(maxError, Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)));
		}

		expect(maxError).toBeLessThan(1e-6);
	});

	it("arbitrary chunk splits are byte-identical to one whole input", () => {
		const input = new Float32Array(37);

		for (let index = 0; index < input.length; index++) {
			input[index] = Math.sin(index * 0.37) * 0.8 + Math.cos(index * 0.11) * 0.1;
		}

		const whole = runFinite(input);
		const chunked = runFinite(input, [1, 3, 8, 9, 21, 34]);

		expect(chunked).toEqual(whole);
	});

	it("uses oversized scratch views and allocates for undersized scratch", () => {
		const input = new Float32Array([0.1, 0.2, 0.3]);
		const oversized = new Float32Array(20);
		const oversizedOutput = new TruePeakUpsampler(4).upsample(input, oversized);

		expect(oversizedOutput.length).toBe(12);
		expect(oversizedOutput.buffer).toBe(oversized.buffer);

		const undersized = new Float32Array(11);
		const undersizedOutput = new TruePeakUpsampler(4).upsample(input, undersized);

		expect(undersizedOutput.length).toBe(12);
		expect(undersizedOutput.buffer).not.toBe(undersized.buffer);

		const flushOversized = new Float32Array(64);
		const flushUpsampler = new TruePeakUpsampler(4);

		flushUpsampler.upsample(input);

		const flushOutput = flushUpsampler.flush(flushOversized);

		expect(flushOutput.length).toBe(44);
		expect(flushOutput.buffer).toBe(flushOversized.buffer);

		const flushUndersized = new Float32Array(43);
		const allocatingFlushUpsampler = new TruePeakUpsampler(4);

		allocatingFlushUpsampler.upsample(input);

		const allocatingFlushOutput = allocatingFlushUpsampler.flush(flushUndersized);

		expect(allocatingFlushOutput.length).toBe(44);
		expect(allocatingFlushOutput.buffer).not.toBe(flushUndersized.buffer);
	});

	it("flush is idempotent and blocks more input until reset", () => {
		const upsampler = new TruePeakUpsampler(4);

		upsampler.upsample(new Float32Array([0.5]));

		expect(upsampler.flush().length).toBe(44);
		expect(upsampler.flush().length).toBe(0);
		expect(() => upsampler.upsample(new Float32Array([0.25]))).toThrow("upsample after flush");

		upsampler.reset();

		expect(() => upsampler.upsample(new Float32Array([0.25]))).not.toThrow();
	});

	it("reset restores the complete cold finite-input result", () => {
		const input = new Float32Array([0.3, -0.2, 0.7, -0.4]);
		const fresh = runFinite(input);
		const reused = new TruePeakUpsampler(4);

		reused.upsample(new Float32Array([0.9, -0.8]));
		reused.flush();
		reused.reset();

		const afterReset = concatenate([reused.upsample(input), reused.flush()]);

		expect(afterReset).toEqual(fresh);
	});

	it("empty input returns empty output before the finite tail is drained", () => {
		const upsampler = new TruePeakUpsampler(4);

		expect(upsampler.upsample(new Float32Array(0)).length).toBe(0);
		expect(upsampler.flush().length).toBe(44);
	});

	it("rejects unsupported factors", () => {
		expect(() => new TruePeakUpsampler(8)).toThrow();
		expect(() => new TruePeakUpsampler(16)).toThrow();
	});
});
