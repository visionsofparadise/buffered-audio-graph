interface BiquadCoefficients {
	fb: [number, number, number];
	fa: [number, number, number];
}

export function biquadFilter(samples: Float32Array, fb: [number, number, number], fa: [number, number, number]): Float32Array {
	const output = new Float32Array(samples.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;

	for (let index = 0; index < samples.length; index++) {
		const x0 = samples[index] ?? 0;
		const y0 = fb[0] * x0 + fb[1] * x1 + fb[2] * x2 - fa[1] * y1 - fa[2] * y2;

		output[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
	}

	return output;
}

export function zeroPhaseBiquadFilter(signal: Float32Array, coefficients: BiquadCoefficients): void {
	// Zero-state forward/backward magnitude-squared filtering; this is not Gustafsson filtfilt.
	const { fb, fa } = coefficients;

	let x1 = 0,
		x2 = 0,
		y1 = 0,
		y2 = 0;

	for (let index = 0; index < signal.length; index++) {
		const x0 = signal[index] ?? 0;
		const y0 = fb[0] * x0 + fb[1] * x1 + fb[2] * x2 - fa[1] * y1 - fa[2] * y2;

		signal[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
	}

	x1 = 0;
	x2 = 0;
	y1 = 0;
	y2 = 0;

	for (let index = signal.length - 1; index >= 0; index--) {
		const x0 = signal[index] ?? 0;
		const y0 = fb[0] * x0 + fb[1] * x1 + fb[2] * x2 - fa[1] * y1 - fa[2] * y2;

		signal[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
	}
}

// Low/high-pass coefficient forms follow Robert Bristow-Johnson's Audio EQ Cookbook (W3C copy).
export function lowPassCoefficients(sampleRate: number, frequency: number, quality: number = Math.SQRT1_2): BiquadCoefficients {
	const w0 = (2 * Math.PI * frequency) / sampleRate;
	const cosW0 = Math.cos(w0);
	const sinW0 = Math.sin(w0);
	const alpha = sinW0 / (2 * quality);
	const a0 = 1 + alpha;

	return {
		fb: [(1 - cosW0) / 2 / a0, (1 - cosW0) / a0, (1 - cosW0) / 2 / a0],
		fa: [1.0, (-2 * cosW0) / a0, (1 - alpha) / a0],
	};
}

export function highPassCoefficients(sampleRate: number, frequency: number, quality: number = Math.SQRT1_2): BiquadCoefficients {
	const w0 = (2 * Math.PI * frequency) / sampleRate;
	const cosW0 = Math.cos(w0);
	const sinW0 = Math.sin(w0);
	const alpha = sinW0 / (2 * quality);
	const a0 = 1 + alpha;

	return {
		fb: [(1 + cosW0) / 2 / a0, (-(1 + cosW0)) / a0, (1 + cosW0) / 2 / a0],
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
		fb: [(vh + (vb * kk) / quality + kk * kk) / a0, (2 * (kk * kk - vh)) / a0, (vh - (vb * kk) / quality + kk * kk) / a0],
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
