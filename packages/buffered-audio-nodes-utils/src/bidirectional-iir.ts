export interface BidirectionalIirOptions {
	smoothingMs: number;
	sampleRate: number;
}

/**
 * One-pole IIR smoothing helper. Single-source-of-truth for the
 * gain-envelope smoothing math used by `loudnessTarget` and any
 * other node that needs the same zero-phase bidirectional shape.
 *
 * For a one-pole low-pass with time constant tau and sample period T:
 *   alpha = 1 - exp(-T / tau)
 *   y[n]  = alpha * x[n] + (1 - alpha) * y[n-1]
 *
 * `applyBidirectional` cascades two passes (forward then backward) for
 * zero-phase response. To make the user-facing `smoothingMs` parameter
 * map to the magnitude response of a single causal pass at tau, each
 * pass uses tau_pass = sqrt(2) * tau. This keeps the parameter's
 * meaning consistent between offline (bidirectional) and any future
 * real-time variant (single causal pass).
 *
 * `applyCausal` is the single-pass form. State is carried by the
 * caller via `{ value: number }` so chunked use can be continuous.
 *
 * `applyForwardPass` is the chunked-streaming forward HALF of the
 * bidirectional cascade — same loop body as `applyCausal`, but using
 * `alphaBidirectional` (the sqrt(2)-compensated alpha) so the result,
 * when followed by `applyBackwardPassInPlace`, matches
 * `applyBidirectional` byte-for-byte. State is caller-managed
 * `{ value: number }` for chunk-boundary continuity.
 *
 * `applyBackwardPassInPlace` runs the backward HALF of the bidirectional
 * cascade IN PLACE on a buffer (overwrites it). Whole-array, not
 * chunked — backward IIR cannot stream forward through chunks because
 * it must walk end-to-start. The "in place" qualifier is the savings:
 * the caller hands in the post-forward buffer; this method overwrites
 * it with the final smoothed result without allocating a separate
 * output array. Init from `buffer[buffer.length - 1]`, matching
 * `applyBidirectional`'s second pass.
 *
 * At `smoothingMs <= 0` all methods are identity (forward / causal
 * return a fresh copy of the input; in-place backward is a no-op).
 */
export class BidirectionalIir {
	private readonly smoothingMs: number;
	private readonly sampleRate: number;
	private readonly alphaBidirectional: number;
	private readonly alphaCausal: number;

	constructor(options: BidirectionalIirOptions) {
		this.smoothingMs = options.smoothingMs;
		this.sampleRate = options.sampleRate;

		const samplePeriod = 1 / this.sampleRate;

		// Bidirectional: each of the two passes uses tau_pass = sqrt(2) * tau
		// so the cascaded magnitude matches a single causal pass at tau.
		const tauBidirectional = (this.smoothingMs / 1000) * Math.SQRT2;

		this.alphaBidirectional = tauBidirectional > 0 ? 1 - Math.exp(-samplePeriod / tauBidirectional) : 1;

		// Causal: tau directly from smoothingMs (single-pass form).
		const tauCausal = this.smoothingMs / 1000;

		this.alphaCausal = tauCausal > 0 ? 1 - Math.exp(-samplePeriod / tauCausal) : 1;
	}

	/**
	 * Bidirectional one-pole IIR with sqrt(2)*tau compensation.
	 * Returns a fresh array; input is not mutated. Identity when
	 * smoothingMs <= 0.
	 */
	applyBidirectional(input: Float32Array): Float32Array {
		const output = Float32Array.from(input);

		if (this.smoothingMs <= 0) return output;

		const alpha = this.alphaBidirectional;
		const oneMinusAlpha = 1 - alpha;

		// Forward pass — initialize from the first sample so a non-zero
		// constant input doesn't decay from zero at the leading edge.
		let y = output[0] ?? 0;

		for (let index = 0; index < output.length; index++) {
			const x = output[index] ?? 0;

			y = alpha * x + oneMinusAlpha * y;
			output[index] = y;
		}

		// Backward pass — initialize from the last sample for the same
		// reason at the trailing edge.
		y = output[output.length - 1] ?? 0;

		for (let index = output.length - 1; index >= 0; index--) {
			const x = output[index] ?? 0;

			y = alpha * x + oneMinusAlpha * y;
			output[index] = y;
		}

		return output;
	}

	/**
	 * Forward-only one-pole IIR, single pass, no compensation. State is
	 * carried by the caller via `{ value: number }` so chunked use can
	 * be continuous. Identity when smoothingMs <= 0 (the input is
	 * returned as a fresh copy so callers can rely on a fresh buffer
	 * regardless).
	 */
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

	/**
	 * Forward HALF of the bidirectional cascade, chunked. Same loop body
	 * as `applyCausal`, but uses `alphaBidirectional` (the sqrt(2)-
	 * compensated alpha) so the output, after a subsequent
	 * `applyBackwardPassInPlace` on the concatenated forward result,
	 * matches `applyBidirectional`'s output byte-for-byte.
	 *
	 * State is carried by the caller via `{ value: number }`. For the
	 * very first chunk the caller must seed `state.value = input[0]`
	 * (matching `applyBidirectional`'s "init from first sample" rule);
	 * for subsequent chunks `state.value` carries the previous chunk's
	 * trailing forward state.
	 *
	 * Identity when smoothingMs <= 0 (returns a fresh copy of the
	 * input).
	 */
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

	/**
	 * Backward HALF of the bidirectional cascade, run IN PLACE on a
	 * whole-array buffer. The buffer is expected to hold the result of
	 * the forward HALF (e.g. produced by chunked `applyForwardPass`
	 * calls concatenated together). Overwrites `buffer` with the final
	 * smoothed result.
	 *
	 * Init from `buffer[buffer.length - 1]`, matching the second pass of
	 * `applyBidirectional`. Uses `alphaBidirectional`.
	 *
	 * Whole-array (not chunked) — backward IIR cannot stream forward
	 * because it must walk end-to-start.
	 *
	 * Identity (no-op) when smoothingMs <= 0.
	 */
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
