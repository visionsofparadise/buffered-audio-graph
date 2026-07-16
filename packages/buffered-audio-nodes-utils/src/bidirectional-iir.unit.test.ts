import { describe, expect, it } from "vitest";
import { BidirectionalIir, getBidirectionalIirAlphas } from "./bidirectional-iir";

function getCausalMagnitude(sampleRate: number, smoothingMs: number): number {
	const ratio = 1000 / sampleRate / smoothingMs;
	const causalPole = Math.exp(-ratio);
	const causal = -Math.expm1(-ratio);
	const sinHalf = Math.sin(Math.min(ratio, Math.PI) / 2);

	return causal / Math.hypot(causal, 2 * Math.sqrt(causalPole) * sinHalf);
}

function getOnePoleMagnitude(alpha: number, omega: number): number {
	return alpha / Math.hypot(alpha, 2 * Math.sqrt(1 - alpha) * Math.sin(omega / 2));
}

function projectSineAmplitude(input: Float32Array, omega: number, start: number, end: number): number {
	let sineSquare = 0;
	let cosineSquare = 0;
	let sineCosine = 0;
	let inputSine = 0;
	let inputCosine = 0;

	for (let index = start; index < end; index++) {
		const sine = Math.sin(omega * index);
		const cosine = Math.cos(omega * index);
		const sample = input[index] ?? 0;

		sineSquare += sine * sine;
		cosineSquare += cosine * cosine;
		sineCosine += sine * cosine;
		inputSine += sample * sine;
		inputCosine += sample * cosine;
	}

	const determinant = sineSquare * cosineSquare - sineCosine * sineCosine;
	const sineAmplitude = (inputSine * cosineSquare - inputCosine * sineCosine) / determinant;
	const cosineAmplitude = (inputCosine * sineSquare - inputSine * sineCosine) / determinant;

	return Math.hypot(sineAmplitude, cosineAmplitude);
}

describe("BidirectionalIir", () => {
	describe("identity at smoothingMs = 0", () => {
		it("applyBidirectional returns a fresh copy bit-for-bit equal to input", () => {
			const iir = new BidirectionalIir({ smoothingMs: 0, sampleRate: 48000 });
			const input = new Float32Array([0, 0.5, -0.25, 1, -1, 0.123, 0.999, 0]);

			const output = iir.applyBidirectional(input);

			expect(output).not.toBe(input);
			expect(output.length).toBe(input.length);

			for (let i = 0; i < input.length; i++) {
				expect(output[i]).toBe(input[i]);
			}
		});

		it("applyCausal returns a fresh copy bit-for-bit equal to input", () => {
			const iir = new BidirectionalIir({ smoothingMs: 0, sampleRate: 48000 });
			const input = new Float32Array([0, 0.5, -0.25, 1, -1, 0.123, 0.999, 0]);
			const state = { value: 0 };

			const output = iir.applyCausal(input, state);

			expect(output).not.toBe(input);
			expect(output.length).toBe(input.length);

			for (let i = 0; i < input.length; i++) {
				expect(output[i]).toBe(input[i]);
			}
		});

		it("finite negative smoothing is also identity", () => {
			const input = new Float32Array([0.25, -0.5, 1]);
			const iir = new BidirectionalIir({ smoothingMs: -1, sampleRate: 48000 });

			expect(iir.applyBidirectional(input)).toEqual(input);
			expect(getBidirectionalIirAlphas(48000, -1)).toEqual({ causal: 1, bidirectional: 1 });
		});
	});

	describe("digital cutoff response", () => {
		it.each([
			{ sampleRate: 48000, smoothingMs: 10 },
			{ sampleRate: 1000, smoothingMs: 1 },
		])("matches the causal one-pole magnitude at $sampleRate Hz and $smoothingMs ms", ({ sampleRate, smoothingMs }) => {
			const ratio = 1000 / sampleRate / smoothingMs;
			const omega = Math.min(ratio, Math.PI);
			const periodSamples = 2 * Math.PI / omega;
			const length = Math.max(16384, Math.ceil(periodSamples * 64));
			const input = new Float32Array(length);

			for (let index = 0; index < length; index++) {
				input[index] = Math.sin(omega * index);
			}

			const output = new BidirectionalIir({ sampleRate, smoothingMs }).applyBidirectional(input);
			const actual = projectSineAmplitude(output, omega, Math.floor(length / 4), Math.floor(length * 3 / 4));
			const expected = getCausalMagnitude(sampleRate, smoothingMs);

			expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-3);
		});

		it("keeps extremely long smoothing finite and matches one-pass and two-pass magnitudes", () => {
			const sampleRate = 48000;
			const smoothingMs = 1e12;
			const ratio = 1000 / sampleRate / smoothingMs;
			const omega = Math.min(ratio, Math.PI);
			const alphas = getBidirectionalIirAlphas(sampleRate, smoothingMs);
			const causalMagnitude = getCausalMagnitude(sampleRate, smoothingMs);
			const bidirectionalPassMagnitude = getOnePoleMagnitude(alphas.bidirectional, omega);

			expect(Number.isFinite(alphas.causal)).toBe(true);
			expect(Number.isFinite(alphas.bidirectional)).toBe(true);
			expect(alphas.causal).toBeGreaterThan(0);
			expect(alphas.bidirectional).toBeGreaterThan(0);
			expect(Math.abs(bidirectionalPassMagnitude ** 2 - causalMagnitude)).toBeLessThan(1e-12);
		});
	});

	describe("validation", () => {
		it.each([0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])("rejects sample rate %s", (sampleRate) => {
			expect(() => new BidirectionalIir({ smoothingMs: 10, sampleRate })).toThrow("sampleRate must be positive and finite");
		});

		it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])("rejects smoothing %s", (smoothingMs) => {
			expect(() => new BidirectionalIir({ smoothingMs, sampleRate: 48000 })).toThrow("smoothingMs must be finite");
		});
	});

	describe("zero phase response on a sine", () => {
		it("bidirectional output peaks align with input peaks for a sine well below cutoff", () => {
			const sampleRate = 48000;
			const smoothingMs = 10;
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });

			const frequencyHz = 2;
			const periodSamples = sampleRate / frequencyHz;
			const length = Math.round(periodSamples * 8);
			const input = new Float32Array(length);

			for (let i = 0; i < length; i++) {
				input[i] = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
			}

			const output = iir.applyBidirectional(input);

			const searchCenter = Math.floor(length / 2);
			const searchHalfWidth = Math.floor(periodSamples / 2);

			let inputPeakIdx = searchCenter;
			let inputPeakValue = input[searchCenter] ?? 0;

			for (let i = searchCenter - searchHalfWidth; i <= searchCenter + searchHalfWidth; i++) {
				const v = input[i] ?? 0;

				if (v > inputPeakValue) {
					inputPeakValue = v;
					inputPeakIdx = i;
				}
			}

			let outputPeakIdx = inputPeakIdx;
			let outputPeakValue = output[inputPeakIdx] ?? 0;

			for (let i = inputPeakIdx - searchHalfWidth; i <= inputPeakIdx + searchHalfWidth; i++) {
				const v = output[i] ?? 0;

				if (v > outputPeakValue) {
					outputPeakValue = v;
					outputPeakIdx = i;
				}
			}

			const peakOffset = Math.abs(outputPeakIdx - inputPeakIdx);
			const tolerance = Math.ceil(periodSamples * 0.01);
			expect(peakOffset).toBeLessThanOrEqual(tolerance);
		});
	});

	describe("applyCausal state continuity", () => {
		it("two halves with state continuation match a single whole-input call", () => {
			const sampleRate = 48000;
			const smoothingMs = 5;
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });

			const length = 4096;
			const input = new Float32Array(length);

			for (let i = 0; i < length; i++) {
				input[i] = Math.sin((2 * Math.PI * 100 * i) / sampleRate) + 0.3;
			}

			const wholeState = { value: 0 };
			const whole = iir.applyCausal(input, wholeState);

			const halfPoint = length / 2;
			const firstHalf = input.slice(0, halfPoint);
			const secondHalf = input.slice(halfPoint);

			const splitState = { value: 0 };
			const firstOut = iir.applyCausal(firstHalf, splitState);
			const secondOut = iir.applyCausal(secondHalf, splitState);

			for (let i = 0; i < halfPoint; i++) {
				expect(firstOut[i]).toBeCloseTo(whole[i]!, 6);
			}

			for (let i = 0; i < halfPoint; i++) {
				expect(secondOut[i]).toBeCloseTo(whole[i + halfPoint]!, 6);
			}
		});
	});

	describe("output length matches input length", () => {
		it("applyBidirectional preserves length", () => {
			const iir = new BidirectionalIir({ smoothingMs: 10, sampleRate: 48000 });

			for (const length of [0, 1, 17, 4096]) {
				const input = new Float32Array(length);
				const output = iir.applyBidirectional(input);
				expect(output.length).toBe(length);
			}
		});

		it("applyCausal preserves length", () => {
			const iir = new BidirectionalIir({ smoothingMs: 10, sampleRate: 48000 });

			for (const length of [0, 1, 17, 4096]) {
				const input = new Float32Array(length);
				const state = { value: 0 };
				const output = iir.applyCausal(input, state);
				expect(output.length).toBe(length);
			}
		});
	});

	describe("non-mutation", () => {
		it("applyBidirectional does not mutate input", () => {
			const iir = new BidirectionalIir({ smoothingMs: 10, sampleRate: 48000 });
			const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0]);
			const reference = Float32Array.from(input);

			iir.applyBidirectional(input);

			for (let i = 0; i < input.length; i++) {
				expect(input[i]).toBe(reference[i]);
			}
		});

		it("applyCausal does not mutate input", () => {
			const iir = new BidirectionalIir({ smoothingMs: 10, sampleRate: 48000 });
			const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0]);
			const reference = Float32Array.from(input);
			const state = { value: 0 };

			iir.applyCausal(input, state);

			for (let i = 0; i < input.length; i++) {
				expect(input[i]).toBe(reference[i]);
			}
		});
	});

	describe("applyForwardPass + applyBackwardPassInPlace", () => {
		const sampleRate = 48000;
		const smoothingMs = 5;

		function makeFixture(length: number): Float32Array {
			const fixture = new Float32Array(length);

			for (let frameIdx = 0; frameIdx < length; frameIdx++) {
				const sine = Math.sin((2 * Math.PI * 100 * frameIdx) / sampleRate);
				const triangle = ((frameIdx % 256) / 256) * 2 - 1;

				fixture[frameIdx] = sine * 0.5 + triangle * 0.3 + 0.2;
			}

			return fixture;
		}

		it("identity at smoothingMs = 0", () => {
			const iir = new BidirectionalIir({ smoothingMs: 0, sampleRate });
			const input = new Float32Array([0, 0.25, -0.5, 0.75, 1, -1, 0.123, 0]);
			const state = { value: 0 };

			const forward = iir.applyForwardPass(input, state);

			expect(forward).not.toBe(input);
			expect(forward.length).toBe(input.length);

			for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
				expect(forward[frameIdx]).toBe(input[frameIdx]);
			}

			const buffer = Float32Array.from(input);

			iir.applyBackwardPassInPlace(buffer);

			for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
				expect(buffer[frameIdx]).toBe(input[frameIdx]);
			}
		});

		it("output length matches input length", () => {
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });

			for (const length of [0, 1, 17, 4096]) {
				const input = new Float32Array(length);
				const state = { value: 0 };
				const forward = iir.applyForwardPass(input, state);

				expect(forward.length).toBe(length);

				const buffer = new Float32Array(length);

				iir.applyBackwardPassInPlace(buffer);
				expect(buffer.length).toBe(length);
			}
		});

		it("applyForwardPass does not mutate input", () => {
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });
			const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0]);
			const reference = Float32Array.from(input);
			const state = { value: input[0] ?? 0 };

			iir.applyForwardPass(input, state);

			for (let frameIdx = 0; frameIdx < input.length; frameIdx++) {
				expect(input[frameIdx]).toBe(reference[frameIdx]);
			}
		});

		it("applyBackwardPassInPlace overwrites the buffer in place", () => {
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });
			const buffer = makeFixture(1024);
			const original = Float32Array.from(buffer);

			iir.applyBackwardPassInPlace(buffer);

			let anyDelta = false;

			for (let frameIdx = 0; frameIdx < buffer.length; frameIdx++) {
				if (buffer[frameIdx] !== original[frameIdx]) {
					anyDelta = true;
					break;
				}
			}

			expect(anyDelta).toBe(true);
		});

		it("forward-pass state continuity: chunked = whole-array (single fixture, multiple split points)", () => {
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });
			const fixture = makeFixture(4096);

			const wholeState = { value: fixture[0] ?? 0 };
			const wholeOutput = iir.applyForwardPass(fixture, wholeState);

			for (const splitPoints of [[1024, 2048, 3072], [333, 1000, 2500], [1, 4095], [2048]]) {
				const chunkedOut = new Float32Array(fixture.length);
				const chunkedState = { value: fixture[0] ?? 0 };
				let writeOffset = 0;
				let readOffset = 0;

				for (const splitPoint of [...splitPoints, fixture.length]) {
					const chunk = fixture.slice(readOffset, splitPoint);
					const chunkOut = iir.applyForwardPass(chunk, chunkedState);

					chunkedOut.set(chunkOut, writeOffset);
					writeOffset += chunkOut.length;
					readOffset = splitPoint;
				}

				expect(writeOffset).toBe(fixture.length);

				for (let frameIdx = 0; frameIdx < fixture.length; frameIdx++) {
					const expected = wholeOutput[frameIdx] ?? 0;
					const actual = chunkedOut[frameIdx] ?? 0;

					expect(Math.abs(expected - actual)).toBeLessThan(1e-6);
				}
			}
		});

		it("backward-pass in-place equivalence vs applyBidirectional's second pass", () => {
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });
			const fixture = makeFixture(4096);

			const reference = iir.applyBidirectional(fixture);

			const forwardState = { value: fixture[0] ?? 0 };
			const buffer = iir.applyForwardPass(fixture, forwardState);

			iir.applyBackwardPassInPlace(buffer);

			for (let frameIdx = 0; frameIdx < fixture.length; frameIdx++) {
				const expected = reference[frameIdx] ?? 0;
				const actual = buffer[frameIdx] ?? 0;

				expect(Math.abs(expected - actual)).toBeLessThan(1e-6);
			}
		});

		it("chunked forward + in-place backward composes to applyBidirectional bytes", () => {
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });
			const fixture = makeFixture(4096);
			const reference = iir.applyBidirectional(fixture);

			const buffer = new Float32Array(fixture.length);
			const state = { value: fixture[0] ?? 0 };
			let writeOffset = 0;

			for (const splitPoint of [333, 1000, 2500, fixture.length]) {
				const chunk = fixture.slice(writeOffset, splitPoint);
				const chunkOut = iir.applyForwardPass(chunk, state);

				buffer.set(chunkOut, writeOffset);
				writeOffset = splitPoint;
			}

			iir.applyBackwardPassInPlace(buffer);

			for (let frameIdx = 0; frameIdx < fixture.length; frameIdx++) {
				const expected = reference[frameIdx] ?? 0;
				const actual = buffer[frameIdx] ?? 0;

				expect(Math.abs(expected - actual)).toBeLessThan(1e-6);
			}
		});
	});
});
