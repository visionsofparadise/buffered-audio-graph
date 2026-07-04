import { preFilterCoefficients, rlbFilterCoefficients } from "./biquad";

export class KWeightedSquaredSum {
	private readonly channelCount: number;

	private readonly preB0: number;
	private readonly preB1: number;
	private readonly preB2: number;
	private readonly preA1: number;
	private readonly preA2: number;
	private readonly rlbB0: number;
	private readonly rlbB1: number;
	private readonly rlbB2: number;
	private readonly rlbA1: number;
	private readonly rlbA2: number;

	private readonly preX1: Float64Array;
	private readonly preX2: Float64Array;
	private readonly preY1: Float64Array;
	private readonly preY2: Float64Array;
	private readonly rlbX1: Float64Array;
	private readonly rlbX2: Float64Array;
	private readonly rlbY1: Float64Array;
	private readonly rlbY2: Float64Array;

	private readonly weights: Float64Array;

	constructor(sampleRate: number, channelCount: number, channelWeights?: ReadonlyArray<number>) {
		if (channelCount <= 0) {
			throw new Error(`KWeightedSquaredSum: channelCount must be positive, got ${channelCount}`);
		}

		const weights = channelWeights ?? new Array<number>(channelCount).fill(1);

		if (weights.length !== channelCount) {
			throw new Error(`KWeightedSquaredSum: channelWeights length ${weights.length} does not match channel count ${channelCount}`);
		}

		this.channelCount = channelCount;

		const preFilter = preFilterCoefficients(sampleRate);
		const rlbFilter = rlbFilterCoefficients(sampleRate);

		this.preB0 = preFilter.fb[0];
		this.preB1 = preFilter.fb[1];
		this.preB2 = preFilter.fb[2];
		this.preA1 = preFilter.fa[1];
		this.preA2 = preFilter.fa[2];
		this.rlbB0 = rlbFilter.fb[0];
		this.rlbB1 = rlbFilter.fb[1];
		this.rlbB2 = rlbFilter.fb[2];
		this.rlbA1 = rlbFilter.fa[1];
		this.rlbA2 = rlbFilter.fa[2];

		this.preX1 = new Float64Array(channelCount);
		this.preX2 = new Float64Array(channelCount);
		this.preY1 = new Float64Array(channelCount);
		this.preY2 = new Float64Array(channelCount);
		this.rlbX1 = new Float64Array(channelCount);
		this.rlbX2 = new Float64Array(channelCount);
		this.rlbY1 = new Float64Array(channelCount);
		this.rlbY2 = new Float64Array(channelCount);

		this.weights = new Float64Array(channelCount);

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			this.weights[channelIndex] = weights[channelIndex] ?? 1;
		}
	}

	// `channels[c]` and `output` need >= `frames` entries from index 0 (oversized OK); `output[i]` gets the K-weighted channel-weighted squared sum at frame `i`; biquad state advances as if appended contiguously.
	push(channels: ReadonlyArray<Float32Array>, frames: number, output: Float64Array): void {
		if (channels.length !== this.channelCount) {
			throw new Error(`KWeightedSquaredSum: push got ${channels.length} channels, expected ${this.channelCount}`);
		}

		if (frames <= 0) return;

		for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex++) {
			const channel = channels[channelIndex] ?? new Float32Array(0);

			if (channel.length < frames) {
				throw new Error(`KWeightedSquaredSum: channel ${channelIndex} has ${channel.length} samples, fewer than the requested ${frames}`);
			}
		}

		if (output.length < frames) {
			throw new Error(`KWeightedSquaredSum: output buffer has ${output.length} entries, fewer than the requested ${frames}`);
		}

		const channelCount = this.channelCount;
		const weights = this.weights;
		const preB0 = this.preB0;
		const preB1 = this.preB1;
		const preB2 = this.preB2;
		const preA1 = this.preA1;
		const preA2 = this.preA2;
		const rlbB0 = this.rlbB0;
		const rlbB1 = this.rlbB1;
		const rlbB2 = this.rlbB2;
		const rlbA1 = this.rlbA1;
		const rlbA2 = this.rlbA2;
		const preX1 = this.preX1;
		const preX2 = this.preX2;
		const preY1 = this.preY1;
		const preY2 = this.preY2;
		const rlbX1 = this.rlbX1;
		const rlbX2 = this.rlbX2;
		const rlbY1 = this.rlbY1;
		const rlbY2 = this.rlbY2;

		for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
			let sampleContribution = 0;

			for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
				const channel = channels[channelIndex] ?? channels[0] ?? new Float32Array(0);
				const x0 = channel[frameIndex] ?? 0;
				const px1 = preX1[channelIndex] ?? 0;
				const px2 = preX2[channelIndex] ?? 0;
				const py1 = preY1[channelIndex] ?? 0;
				const py2 = preY2[channelIndex] ?? 0;
				const preY = preB0 * x0 + preB1 * px1 + preB2 * px2 - preA1 * py1 - preA2 * py2;

				preX2[channelIndex] = px1;
				preX1[channelIndex] = x0;
				preY2[channelIndex] = py1;
				preY1[channelIndex] = preY;

				const rx1 = rlbX1[channelIndex] ?? 0;
				const rx2 = rlbX2[channelIndex] ?? 0;
				const ry1 = rlbY1[channelIndex] ?? 0;
				const ry2 = rlbY2[channelIndex] ?? 0;
				const rlbY = rlbB0 * preY + rlbB1 * rx1 + rlbB2 * rx2 - rlbA1 * ry1 - rlbA2 * ry2;

				rlbX2[channelIndex] = rx1;
				rlbX1[channelIndex] = preY;
				rlbY2[channelIndex] = ry1;
				rlbY1[channelIndex] = rlbY;

				sampleContribution += (weights[channelIndex] ?? 1) * rlbY * rlbY;
			}

			output[frameIndex] = sampleContribution;
		}
	}
}
