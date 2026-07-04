import { lowPassCoefficients } from "./biquad";

export type OversamplingFactor = 1 | 2 | 4 | 8;

const BUTTERWORTH_Q_STAGE_1 = 1 / (2 * Math.cos((3 * Math.PI) / 8));
const BUTTERWORTH_Q_STAGE_2 = 1 / (2 * Math.cos(Math.PI / 8));

interface BiquadState {
	s1: number;
	s2: number;
}

function makeBiquadState(): BiquadState {
	return { s1: 0, s2: 0 };
}

// Direct form II transposed (more stable than DF1 for audio). fb = numerator [b0,b1,b2]; fa = denominator [1,a1,a2] (a[0] must be 1).
function biquadSample(sample: number, fb: [number, number, number], fa: [number, number, number], state: BiquadState): number {
	const y = fb[0] * sample + state.s1;

	state.s1 = fb[1] * sample - fa[1] * y + state.s2;
	state.s2 = fb[2] * sample - fa[2] * y;

	return y;
}

export class Oversampler {
	/** The oversampling factor this instance was constructed with (1/2/4/8). */
	readonly factor: OversamplingFactor;
	private readonly fb1: [number, number, number];
	private readonly fa1: [number, number, number];
	private readonly fb2: [number, number, number];
	private readonly fa2: [number, number, number];
	private upState1: BiquadState;
	private upState2: BiquadState;
	private downState1: BiquadState;
	private downState2: BiquadState;

	constructor(factor: OversamplingFactor, sampleRate: number) {
		this.factor = factor;
		this.upState1 = makeBiquadState();
		this.upState2 = makeBiquadState();
		this.downState1 = makeBiquadState();
		this.downState2 = makeBiquadState();

		if (factor === 1) {
			// Coefficients unused at factor 1; identity values keep the readonly fields initialised.
			this.fb1 = [1, 0, 0];
			this.fa1 = [1, 0, 0];
			this.fb2 = [1, 0, 0];
			this.fa2 = [1, 0, 0];

			return;
		}

		const cutoffHz = sampleRate * 0.45;
		const oversampledRate = sampleRate * factor;

		const stage1 = lowPassCoefficients(oversampledRate, cutoffHz, BUTTERWORTH_Q_STAGE_1);
		const stage2 = lowPassCoefficients(oversampledRate, cutoffHz, BUTTERWORTH_Q_STAGE_2);

		this.fb1 = stage1.fb;
		this.fa1 = stage1.fa;
		this.fb2 = stage2.fb;
		this.fa2 = stage2.fa;
	}

	upsample(input: Float32Array): Float32Array {
		if (this.factor === 1) return input.slice();

		const factor = this.factor;
		const inputLength = input.length;
		const upLength = inputLength * factor;
		const upsampled = new Float32Array(upLength);

		// ×factor scaling compensates for the zero-insertion so the LP filter preserves amplitude.
		for (let index = 0; index < inputLength; index++) {
			upsampled[index * factor] = (input[index] ?? 0) * factor;
		}

		for (let index = 0; index < upLength; index++) {
			const stage1Out = biquadSample(upsampled[index] ?? 0, this.fb1, this.fa1, this.upState1);

			upsampled[index] = biquadSample(stage1Out, this.fb2, this.fa2, this.upState2);
		}

		return upsampled;
	}

	downsample(input: Float32Array): Float32Array {
		if (this.factor === 1) return input.slice();

		const factor = this.factor;
		const inputLength = input.length;
		const outLength = Math.floor(inputLength / factor);
		const output = new Float32Array(outLength);

		for (let index = 0; index < inputLength; index++) {
			const stage1Out = biquadSample(input[index] ?? 0, this.fb1, this.fa1, this.downState1);
			const filtered = biquadSample(stage1Out, this.fb2, this.fa2, this.downState2);

			if (index % factor === 0) {
				const outIdx = index / factor;

				if (outIdx < outLength) output[outIdx] = filtered;
			}
		}

		return output;
	}

	oversample(input: Float32Array, callback: (x: number) => number): Float32Array {
		const up = this.upsample(input);

		for (let index = 0; index < up.length; index++) {
			up[index] = callback(up[index] ?? 0);
		}

		return this.downsample(up);
	}

	reset(): void {
		this.upState1.s1 = 0;
		this.upState1.s2 = 0;
		this.upState2.s1 = 0;
		this.upState2.s2 = 0;
		this.downState1.s1 = 0;
		this.downState1.s2 = 0;
		this.downState2.s1 = 0;
		this.downState2.s2 = 0;
	}
}
