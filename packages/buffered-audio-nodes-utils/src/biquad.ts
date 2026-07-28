interface BiquadCoefficients {
	fb: [number, number, number];
	fa: [number, number, number];
}

function applyBiquadPass(
	input: Float32Array,
	output: Float32Array,
	fb: [number, number, number],
	fa: [number, number, number],
	reverse: boolean,
): void {
	const step = reverse ? -1 : 1;
	let index = reverse ? input.length - 1 : 0;
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;

	for (let remaining = input.length; remaining > 0; remaining--) {
		const x0 = input[index] ?? 0;
		const y0 = fb[0] * x0 + fb[1] * x1 + fb[2] * x2 - fa[1] * y1 - fa[2] * y2;

		output[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
		index += step;
	}
}

export function biquadFilter(
	samples: Float32Array,
	fb: [number, number, number],
	fa: [number, number, number],
): Float32Array {
	const output = new Float32Array(samples.length);

	applyBiquadPass(samples, output, fb, fa, false);

	return output;
}

export function zeroPhaseBiquadFilter(signal: Float32Array, coefficients: BiquadCoefficients): void {
	const { fb, fa } = coefficients;

	applyBiquadPass(signal, signal, fb, fa, false);
	applyBiquadPass(signal, signal, fb, fa, true);
}

// eslint-disable-next-line comment-rules/no-restricted-comments
// Low/high-pass coefficient forms follow Robert Bristow-Johnson's Audio EQ Cookbook (W3C copy).
function cookbookIntermediates(
	sampleRate: number,
	frequency: number,
	quality: number,
): { readonly cosW0: number; readonly alpha: number; readonly a0: number } {
	const w0 = (2 * Math.PI * frequency) / sampleRate;
	const cosW0 = Math.cos(w0);
	const sinW0 = Math.sin(w0);
	const alpha = sinW0 / (2 * quality);

	return { cosW0, alpha, a0: 1 + alpha };
}

export function lowPassCoefficients(
	sampleRate: number,
	frequency: number,
	quality: number = Math.SQRT1_2,
): BiquadCoefficients {
	const { cosW0, alpha, a0 } = cookbookIntermediates(sampleRate, frequency, quality);

	return {
		fb: [(1 - cosW0) / 2 / a0, (1 - cosW0) / a0, (1 - cosW0) / 2 / a0],
		fa: [1.0, (-2 * cosW0) / a0, (1 - alpha) / a0],
	};
}

export function highPassCoefficients(
	sampleRate: number,
	frequency: number,
	quality: number = Math.SQRT1_2,
): BiquadCoefficients {
	const { cosW0, alpha, a0 } = cookbookIntermediates(sampleRate, frequency, quality);

	return {
		fb: [(1 + cosW0) / 2 / a0, -(1 + cosW0) / a0, (1 + cosW0) / 2 / a0],
		fa: [1.0, (-2 * cosW0) / a0, (1 - alpha) / a0],
	};
}

export function preFilterCoefficients(sampleRate: number): BiquadCoefficients {
	if (sampleRate === 48000) {
		return {
			fb: [1.53512485958697, -2.69169618940638, 1.19839281085285],
			fa: [1.0, -1.69065929318241, 0.73248077421585],
		};
	}

	const freq = 1681.974450955533;
	const gain = 3.999843853973347;
	const quality = 0.7071752369554196;

	const kk = Math.tan((Math.PI * freq) / sampleRate);
	const vh = Math.pow(10, gain / 20);
	const vb = Math.pow(vh, 0.4996667741545416);
	const a0 = 1 + kk / quality + kk * kk;

	return {
		fb: [
			(vh + (vb * kk) / quality + kk * kk) / a0,
			(2 * (kk * kk - vh)) / a0,
			(vh - (vb * kk) / quality + kk * kk) / a0,
		],
		fa: [1.0, (2 * (kk * kk - 1)) / a0, (1 - kk / quality + kk * kk) / a0],
	};
}

export function rlbFilterCoefficients(sampleRate: number): BiquadCoefficients {
	if (sampleRate === 48000) {
		return {
			fb: [1.0, -2.0, 1.0],
			fa: [1.0, -1.99004745483398, 0.99007225036621],
		};
	}

	const freq = 38.13547087602444;
	const quality = 0.5003270373238773;

	const kk = Math.tan((Math.PI * freq) / sampleRate);
	const a0 = 1 + kk / quality + kk * kk;

	return {
		fb: [1 / a0, -2 / a0, 1 / a0],
		fa: [1.0, (2 * (kk * kk - 1)) / a0, (1 - kk / quality + kk * kk) / a0],
	};
}
