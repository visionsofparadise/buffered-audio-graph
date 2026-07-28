export interface ValidationResult {
	readonly pass: boolean;
	readonly reason?: string;
}

export function notSilent(samples: Array<Float32Array>): ValidationResult {
	let sumSquares = 0;
	let totalSamples = 0;

	for (const channel of samples) {
		for (const sample of channel) {
			sumSquares += sample * sample;
		}

		totalSamples += channel.length;
	}

	const rms = Math.sqrt(sumSquares / Math.max(totalSamples, 1));

	if (rms < 1e-6) {
		return { pass: false, reason: `Output is silent (RMS: ${rms.toExponential(2)})` };
	}

	return { pass: true };
}

export function expectedDuration(samples: Array<Float32Array>, expected: number, tolerance = 0.01): ValidationResult {
	const actual = samples[0]?.length ?? 0;
	const diff = Math.abs(actual - expected);
	const relDiff = diff / Math.max(expected, 1);

	if (relDiff > tolerance) {
		return {
			pass: false,
			reason: `Duration mismatch: expected ${expected} frames, got ${actual} (${(relDiff * 100).toFixed(1)}% off)`,
		};
	}

	return { pass: true };
}

export function somethingChanged(
	inputSamples: Array<Float32Array>,
	outputSamples: Array<Float32Array>,
): ValidationResult {
	let inputSum = 0;
	let outputSum = 0;

	for (const channel of inputSamples) {
		for (const sample of channel) {
			inputSum += sample * sample;
		}
	}

	for (const channel of outputSamples) {
		for (const sample of channel) {
			outputSum += sample * sample;
		}
	}

	if (Math.abs(inputSum - outputSum) < 1e-10) {
		return { pass: false, reason: "Output is identical to input (sum of squares match)" };
	}

	return { pass: true };
}

export function notAnomalous(samples: Array<Float32Array>): ValidationResult {
	let totalSamples = 0;
	let zeroCount = 0;
	let clipCount = 0;

	for (const channel of samples) {
		for (let index = 0; index < channel.length; index++) {
			const sample = channel[index] ?? 0;

			if (!Number.isFinite(sample)) {
				return { pass: false, reason: `Output contains non-finite value at index ${index}: ${sample}` };
			}

			if (sample === 0) zeroCount++;
			if (Math.abs(sample) >= 1.0) clipCount++;
			totalSamples++;
		}
	}

	if (totalSamples === 0) {
		return { pass: false, reason: "Output has no samples" };
	}

	const clipRatio = clipCount / totalSamples;

	if (clipRatio > 0.1) {
		return { pass: false, reason: `Output is heavily clipped (${(clipRatio * 100).toFixed(1)}% at ±1.0)` };
	}

	const zeroRatio = zeroCount / totalSamples;

	if (zeroRatio > 0.9) {
		return { pass: false, reason: `Output is pathologically sparse (${(zeroRatio * 100).toFixed(1)}% zeros)` };
	}

	return { pass: true };
}
