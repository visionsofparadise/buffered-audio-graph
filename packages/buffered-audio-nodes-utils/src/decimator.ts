import { lowPassCoefficients, zeroPhaseBiquadFilter } from "./biquad";

const MIN_R = 1;
const MAX_R = 64;

const LOLLMANN_F_EFF = 3200;

const CUTOFF_MARGIN = 0.9;

export function decimate(input: Float32Array, rate: number): Float32Array {
	if (!Number.isInteger(rate) || rate < MIN_R) {
		throw new Error(`decimate: rate must be a positive integer, got ${String(rate)}`);
	}

	if (rate === 1) return Float32Array.from(input);

	// sampleRate=1 → `frequency` arg is a normalised cutoff (cycles/sample) directly.
	const fcNorm = CUTOFF_MARGIN / (2 * rate);
	const coefficients = lowPassCoefficients(1, fcNorm);

	const filtered = Float32Array.from(input);

	zeroPhaseBiquadFilter(filtered, coefficients);

	const outLength = Math.floor(input.length / rate);
	const output = new Float32Array(outLength);

	for (let index = 0; index < outLength; index++) {
		output[index] = filtered[index * rate] ?? 0;
	}

	return output;
}

export function integerDecimationRate(sourceSampleRate: number): number {
	if (sourceSampleRate === 48000) return 15;
	if (sourceSampleRate === 44100) return 14;

	const rate = Math.round(sourceSampleRate / LOLLMANN_F_EFF);

	return Math.min(MAX_R, Math.max(MIN_R, rate));
}
