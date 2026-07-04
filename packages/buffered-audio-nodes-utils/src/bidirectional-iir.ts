export interface BidirectionalIirOptions {
	smoothingMs: number;
	sampleRate: number;
}

export class BidirectionalIir {
	private readonly smoothingMs: number;
	private readonly sampleRate: number;
	private readonly alphaBidirectional: number;
	private readonly alphaCausal: number;

	constructor(options: BidirectionalIirOptions) {
		this.smoothingMs = options.smoothingMs;
		this.sampleRate = options.sampleRate;

		const samplePeriod = 1 / this.sampleRate;

		const tauBidirectional = (this.smoothingMs / 1000) * Math.SQRT2;

		this.alphaBidirectional = tauBidirectional > 0 ? 1 - Math.exp(-samplePeriod / tauBidirectional) : 1;

		const tauCausal = this.smoothingMs / 1000;

		this.alphaCausal = tauCausal > 0 ? 1 - Math.exp(-samplePeriod / tauCausal) : 1;
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
