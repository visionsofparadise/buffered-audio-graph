import { describe, expect, it } from "vitest";
import { applyBaseRateChunk } from "./apply";

const SAMPLE_RATE = 48_000;

/**
 * Tiny LCG (numerical-recipes constants) for deterministic noise.
 */
function makeLcg(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

		return state / 0x80_00_00_00 - 1;
	};
}

function makeSineWithNoise(seed: number, frames: number, amplitude: number, frequency: number): Float32Array {
	const channel = new Float32Array(frames);
	const rand = makeLcg(seed);
	const angularStep = (2 * Math.PI * frequency) / SAMPLE_RATE;

	for (let frameIdx = 0; frameIdx < frames; frameIdx++) {
		channel[frameIdx] = amplitude * (0.7 * Math.sin(angularStep * frameIdx) + 0.3 * rand());
	}

	return channel;
}

/**
 * Base-rate ramp envelope of length `frames`. Mirrors the upsampled
 * `makeRampGainUpsampled` from the prior 4×-rate apply tests but
 * scaled to base rate (post the 2026-05-13 base-rate-downstream
 * rewrite — the envelope is single-channel at base rate).
 */
function makeRampGain(frames: number, fromGain: number, toGain: number): Float32Array {
	const envelope = new Float32Array(frames);

	for (let frameIdx = 0; frameIdx < frames; frameIdx++) {
		const t = frames <= 1 ? 0 : frameIdx / (frames - 1);

		envelope[frameIdx] = fromGain + (toGain - fromGain) * t;
	}

	return envelope;
}

describe("applyBaseRateChunk", () => {
	it("output equals per-sample source × envelope multiply at base rate", () => {
		// Anchor: the helper IS a plain per-sample multiply at base
		// rate. Verify the bytes match an inline reference exactly
		// modulo IEEE-754 multiply order (zero with our compiler).
		const frames = 1024;
		const sourceL = makeSineWithNoise(0xc0de_babe, frames, 0.25, 1000);
		const sourceR = makeSineWithNoise(0xface_feed, frames, 0.2, 1500);
		const envelope = makeRampGain(frames, 0.5, 1.0);

		const output = applyBaseRateChunk({
			chunkSamples: [sourceL, sourceR],
			smoothedGain: envelope,
		});

		expect(output.length).toBe(2);

		for (let ch = 0; ch < 2; ch++) {
			const got = output[ch]!;
			const source = ch === 0 ? sourceL : sourceR;

			expect(got.length).toBe(frames);

			// Reference also goes through Float32Array storage so the
			// f32 rounding matches byte-for-byte. Comparing f64
			// arithmetic against an f32-rounded output would drift by
			// ~ULP (~1e-7) and fail the strict-equality assertion.
			const reference = new Float32Array(frames);

			for (let i = 0; i < frames; i++) {
				reference[i] = (source[i] ?? 0) * (envelope[i] ?? 0);
			}

			let maxDiff = 0;

			for (let i = 0; i < frames; i++) {
				const diff = Math.abs((got[i] ?? 0) - (reference[i] ?? 0));

				if (diff > maxDiff) maxDiff = diff;
			}

			expect(maxDiff).toBe(0);
		}
	});

	it("multi-chunk apply matches single-chunk apply (stateless helper, base rate)", () => {
		// The helper is stateless (unlike the prior 4×-rate path with
		// persistent biquad downsamplers), so multi-chunk and
		// single-chunk paths must produce byte-identical outputs when
		// the same envelope is sliced consistently across chunk
		// boundaries.
		const frames = 4096;
		const source = makeSineWithNoise(0x0a0b_0c0d, frames, 0.2, 1000);
		const envelope = makeRampGain(frames, 0.5, 1.0);

		// Single-chunk path.
		const [single] = applyBaseRateChunk({
			chunkSamples: [source],
			smoothedGain: envelope,
		});

		// Multi-chunk paths — split at different granularities.
		const splitPoints: ReadonlyArray<ReadonlyArray<number>> = [
			[2048],
			[1024, 2048, 3072],
			[256, 768, 1024, 1500, 2500, 3000, 3500],
		];

		for (const splits of splitPoints) {
			const reassembled = new Float32Array(frames);
			let cursor = 0;

			const boundaries = [...splits, frames];

			for (const boundary of boundaries) {
				const chunkSlice = new Float32Array(source.subarray(cursor, boundary));
				const envelopeSlice = envelope.subarray(cursor, boundary);
				const [chunkOut] = applyBaseRateChunk({
					chunkSamples: [chunkSlice],
					smoothedGain: envelopeSlice,
				});

				expect(chunkOut?.length).toBe(boundary - cursor);

				reassembled.set(chunkOut ?? new Float32Array(0), cursor);
				cursor = boundary;
			}

			let maxError = 0;

			for (let frameIdx = 0; frameIdx < frames; frameIdx++) {
				const diff = Math.abs((single?.[frameIdx] ?? 0) - reassembled[frameIdx]!);

				if (diff > maxError) maxError = diff;
			}

			expect(maxError).toBe(0);
		}
	});

	it("constant gain reduces to native scalar multiply", () => {
		const frames = 1024;
		const source = makeSineWithNoise(0x1357_2468, frames, 0.25, 440);
		const constant = 0.6;

		const envelope = new Float32Array(frames);

		envelope.fill(constant);

		const [output] = applyBaseRateChunk({
			chunkSamples: [source],
			smoothedGain: envelope,
		});

		expect(output?.length).toBe(frames);

		// Reference also goes through Float32Array storage so the f32
		// rounding matches byte-for-byte. Critically, read the
		// constant FROM the f32 envelope (not the original JS f64
		// literal) — `Float32Array.fill(0.6)` stores the f32-rounded
		// representation, and the helper reads that rounded value
		// from the array. Multiplying by the original f64 `0.6` would
		// produce a slightly different product that rounds to a
		// neighbouring f32 in some samples.
		const f32Constant = envelope[0] ?? 0;
		const reference = new Float32Array(frames);

		for (let frameIdx = 0; frameIdx < frames; frameIdx++) {
			reference[frameIdx] = (source[frameIdx] ?? 0) * f32Constant;
		}

		let maxError = 0;

		for (let frameIdx = 0; frameIdx < frames; frameIdx++) {
			const diff = Math.abs((output?.[frameIdx] ?? 0) - (reference[frameIdx] ?? 0));

			if (diff > maxError) maxError = diff;
		}

		expect(maxError).toBe(0);
	});

	it("caller-provided `output` produces byte-equal results to the default-allocate path", () => {
		// The optional `output` parameter lets the caller pre-allocate
		// output slots and write into them in-place instead of
		// allocating fresh per call. Used by `measureAttemptOutput` to
		// hoist the per-chunk apply output to a persistent caller-side
		// scratch. The two paths must produce byte-equal results.
		const frames = 2048;
		const sourceL = makeSineWithNoise(0xc0de_babe, frames, 0.25, 1000);
		const sourceR = makeSineWithNoise(0xface_feed, frames, 0.2, 1500);
		const envelope = makeRampGain(frames, 0.5, 1.0);

		const defaultOutput = applyBaseRateChunk({
			chunkSamples: [sourceL, sourceR],
			smoothedGain: envelope,
		});

		const overrideOutput: Array<Float32Array> = [new Float32Array(frames), new Float32Array(frames)];
		const overrideReturn = applyBaseRateChunk({
			chunkSamples: [sourceL, sourceR],
			smoothedGain: envelope,
			output: overrideOutput,
		});

		expect(overrideReturn).toBe(overrideOutput);
		expect(defaultOutput.length).toBe(2);
		expect(overrideOutput.length).toBe(2);

		for (let channelIdx = 0; channelIdx < 2; channelIdx++) {
			const defaultChannel = defaultOutput[channelIdx]!;
			const overrideChannel = overrideOutput[channelIdx]!;

			expect(overrideChannel.length).toBe(defaultChannel.length);

			for (let frameIdx = 0; frameIdx < defaultChannel.length; frameIdx++) {
				expect(overrideChannel[frameIdx]).toBe(defaultChannel[frameIdx]);
			}
		}
	});

	it("caller-provided `output` with mismatched channel count throws", () => {
		const frames = 1024;
		const source = makeSineWithNoise(0x1111_2222, frames, 0.25, 440);
		const envelope = makeRampGain(frames, 0.5, 1.0);

		expect(() => {
			applyBaseRateChunk({
				chunkSamples: [source],
				smoothedGain: envelope,
				output: [new Float32Array(frames), new Float32Array(frames)],
			});
		}).toThrow(/output array length/);
	});

	it("caller-provided `output` with wrong per-channel length throws", () => {
		const frames = 1024;
		const source = makeSineWithNoise(0x3333_4444, frames, 0.25, 440);
		const envelope = makeRampGain(frames, 0.5, 1.0);

		expect(() => {
			applyBaseRateChunk({
				chunkSamples: [source],
				smoothedGain: envelope,
				output: [new Float32Array(frames - 1)],
			});
		}).toThrow(/length/);
	});

	it("envelope shorter than chunk throws (caller must slice to match)", () => {
		const frames = 1024;
		const source = makeSineWithNoise(0x5555_6666, frames, 0.25, 440);
		const envelope = makeRampGain(frames - 1, 0.5, 1.0); // one short

		expect(() => {
			applyBaseRateChunk({
				chunkSamples: [source],
				smoothedGain: envelope,
			});
		}).toThrow(/smoothedGain length/);
	});

	it("empty channel list returns empty result", () => {
		const envelope = makeRampGain(1024, 0.5, 1.0);
		const output = applyBaseRateChunk({
			chunkSamples: [],
			smoothedGain: envelope,
		});

		expect(output.length).toBe(0);
	});
});
