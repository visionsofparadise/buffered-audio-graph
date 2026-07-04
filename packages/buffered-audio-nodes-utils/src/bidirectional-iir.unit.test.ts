import { BidirectionalIir } from "./bidirectional-iir";

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
	});

	describe("step response settles toward 1", () => {
		it("bidirectional output settles toward 1 after the step and matches the expected -3 dB cutoff", () => {
			const sampleRate = 48000;
			const smoothingMs = 10;
			const iir = new BidirectionalIir({ smoothingMs, sampleRate });

			const length = 8192;
			const stepStart = length / 4;
			const input = new Float32Array(length);

			for (let i = stepStart; i < length; i++) input[i] = 1;

			const output = iir.applyBidirectional(input);

			const tail = output[length - 1] ?? 0;
			expect(tail).toBeGreaterThan(0.99);
			expect(tail).toBeLessThan(1.0001);

			const head = output[0] ?? 0;
			expect(Math.abs(head)).toBeLessThan(0.05);

			const cutoffHz = 1 / (2 * Math.PI * (smoothingMs / 1000));

			const referenceRms = Math.SQRT1_2;

			const magnitudeAt = (frequencyHz: number): number => {
				const cyclesNeeded = 8;
				const periodSamples = sampleRate / frequencyHz;
				const sineLength = Math.max(8192, Math.ceil(periodSamples * cyclesNeeded * 2));
				const sine = new Float32Array(sineLength);

				for (let i = 0; i < sineLength; i++) {
					sine[i] = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
				}

				const filtered = iir.applyBidirectional(sine);

				const startIdx = Math.floor(sineLength / 4);
				const endIdx = Math.floor((3 * sineLength) / 4);
				let sumSq = 0;

				for (let i = startIdx; i < endIdx; i++) {
					const v = filtered[i] ?? 0;
					sumSq += v * v;
				}

				return Math.sqrt(sumSq / (endIdx - startIdx));
			};

			const cutoffMagnitude = magnitudeAt(cutoffHz) / referenceRms;

			expect(cutoffMagnitude).toBeGreaterThan(0.25);
			expect(cutoffMagnitude).toBeLessThan(0.45);

			const lowMagnitude = magnitudeAt(cutoffHz / 8) / referenceRms;
			expect(lowMagnitude).toBeGreaterThan(0.95);

			const highMagnitude = magnitudeAt(cutoffHz * 50) / referenceRms;
			expect(highMagnitude).toBeLessThan(0.1);
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
