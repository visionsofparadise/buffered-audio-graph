export interface BidirectionalIirOptions {
	smoothingMs: number;
	sampleRate: number;
}

export function getBidirectionalIirAlphas(
	sampleRate: number,
	smoothingMs: number,
): { readonly causal: number; readonly bidirectional: number } {
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

function runForwardPass(buffer: Float32Array, alpha: number, initial: number): number {
	const oneMinusAlpha = 1 - alpha;
	let y = initial;

	for (let index = 0; index < buffer.length; index++) {
		const x = buffer[index] ?? 0;

		y = alpha * x + oneMinusAlpha * y;
		buffer[index] = y;
	}

	return y;
}

function runBackwardPass(buffer: Float32Array, alpha: number, initial: number): number {
	const oneMinusAlpha = 1 - alpha;
	let y = initial;

	for (let index = buffer.length - 1; index >= 0; index--) {
		const x = buffer[index] ?? 0;

		y = alpha * x + oneMinusAlpha * y;
		buffer[index] = y;
	}

	return y;
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

		runForwardPass(output, this.alphaBidirectional, output[0] ?? 0);
		runBackwardPass(output, this.alphaBidirectional, output[output.length - 1] ?? 0);

		return output;
	}

	applyCausal(input: Float32Array, state: { value: number }): Float32Array {
		const output = Float32Array.from(input);

		if (this.smoothingMs <= 0) return output;

		state.value = runForwardPass(output, this.alphaCausal, state.value);

		return output;
	}

	applyForwardPass(input: Float32Array, state: { value: number }): Float32Array {
		const output = Float32Array.from(input);

		if (this.smoothingMs <= 0) return output;

		state.value = runForwardPass(output, this.alphaBidirectional, state.value);

		return output;
	}

	applyBackwardPassInPlace(buffer: Float32Array): void {
		if (this.smoothingMs <= 0) return;

		if (buffer.length === 0) return;

		runBackwardPass(buffer, this.alphaBidirectional, buffer[buffer.length - 1] ?? 0);
	}
}
