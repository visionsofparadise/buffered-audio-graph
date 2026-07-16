export interface BidirectionalIirOptions {
	smoothingMs: number;
	sampleRate: number;
}

export function getBidirectionalIirAlphas(sampleRate: number, smoothingMs: number): { readonly causal: number; readonly bidirectional: number } {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new Error(`BidirectionalIir: sampleRate must be positive and finite, got ${sampleRate}`);
	}

	if (!Number.isFinite(smoothingMs)) {
		throw new Error(`BidirectionalIir: smoothingMs must be finite, got ${smoothingMs}`);
	}

	if (smoothingMs <= 0) return { causal: 1, bidirectional: 1 };

	const ratio = 1000 / sampleRate / smoothingMs;
	const causalPole = Math.exp(-ratio);
	const causal = -Math.expm1(-ratio);
	const omega = Math.min(ratio, Math.PI);
	const sinHalf = Math.sin(omega / 2);
	const causalMagnitude = causal / Math.hypot(causal, 2 * Math.sqrt(causalPole) * sinHalf);
	const transformedFrequency = 2 * sinHalf * Math.sqrt(causalMagnitude / (1 - causalMagnitude));
	const bidirectional = -Math.expm1(-2 * Math.asinh(transformedFrequency / 2));

	return { causal, bidirectional };
}

export class BidirectionalIir {
	private readonly smoothingMs: number;
	private readonly alphaBidirectional: number;
	private readonly alphaCausal: number;

	constructor(options: BidirectionalIirOptions) {
		this.smoothingMs = options.smoothingMs;
		const alphas = getBidirectionalIirAlphas(options.sampleRate, options.smoothingMs);

		this.alphaBidirectional = alphas.bidirectional;
		this.alphaCausal = alphas.causal;
	}

	applyBidirectional(input: Float32Array): Float32Array {
		const output = Float32Array.from(input);

		if (this.smoothingMs <= 0) return output;

		const alpha = this.alphaBidirectional;
		const oneMinusAlpha = 1 - alpha;

		let y = output[0] ?? 0;

		for (let index = 0; index < output.length; index++) {
			const x = output[index] ?? 0;

			y = alpha * x + oneMinusAlpha * y;
			output[index] = y;
		}

		y = output[output.length - 1] ?? 0;

		for (let index = output.length - 1; index >= 0; index--) {
			const x = output[index] ?? 0;

			y = alpha * x + oneMinusAlpha * y;
			output[index] = y;
		}

		return output;
	}

	applyCausal(input: Float32Array, state: { value: number }): Float32Array {
		const output = Float32Array.from(input);

		if (this.smoothingMs <= 0) return output;

		const alpha = this.alphaCausal;
		const oneMinusAlpha = 1 - alpha;
		let y = state.value;

		for (let index = 0; index < output.length; index++) {
			const x = output[index] ?? 0;

			y = alpha * x + oneMinusAlpha * y;
			output[index] = y;
		}

		state.value = y;

		return output;
	}

	applyForwardPass(input: Float32Array, state: { value: number }): Float32Array {
		const output = Float32Array.from(input);

		if (this.smoothingMs <= 0) return output;

		const alpha = this.alphaBidirectional;
		const oneMinusAlpha = 1 - alpha;
		let y = state.value;

		for (let index = 0; index < output.length; index++) {
			const x = output[index] ?? 0;

			y = alpha * x + oneMinusAlpha * y;
			output[index] = y;
		}

		state.value = y;

		return output;
	}

	applyBackwardPassInPlace(buffer: Float32Array): void {
		if (this.smoothingMs <= 0) return;
		if (buffer.length === 0) return;

		const alpha = this.alphaBidirectional;
		const oneMinusAlpha = 1 - alpha;
		let y = buffer[buffer.length - 1] ?? 0;

		for (let index = buffer.length - 1; index >= 0; index--) {
			const x = buffer[index] ?? 0;

			y = alpha * x + oneMinusAlpha * y;
			buffer[index] = y;
		}
	}
}
