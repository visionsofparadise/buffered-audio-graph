// Coefficients from the libebur128 reference `interpolator.c` (`g_true_peak_4x_coefficients`), mirroring BS.1770-4 Annex 1 table 4. https://github.com/jiixyj/libebur128

const TAPS_PER_PHASE_4X = 12;
const HISTORY_LENGTH_4X = TAPS_PER_PHASE_4X;

// libebur128 `ebur128.c` (`interp_create` / `g_true_peak_4x_coefficients`), a literal transcription of BS.1770-4 Annex 1.
const P1T0 = 0.0017089843750;
const P1T1 = 0.0109863281250;
const P1T2 = -0.0196533203125;
const P1T3 = 0.0332031250000;
const P1T4 = -0.0594482421875;
const P1T5 = 0.1373291015625;
const P1T6 = 0.9721679687500;
const P1T7 = -0.1022949218750;
const P1T8 = 0.0476074218750;
const P1T9 = -0.0266113281250;
const P1T10 = 0.0148925781250;
const P1T11 = -0.0083007812500;

const P2T0 = -0.0291748046875;
const P2T1 = 0.0292968750000;
const P2T2 = -0.0517578125000;
const P2T3 = 0.0891113281250;
const P2T4 = -0.1665039062500;
const P2T5 = 0.4650878906250;
const P2T6 = 0.7797851562500;
const P2T7 = -0.2003173828125;
const P2T8 = 0.1015625000000;
const P2T9 = -0.0582275390625;
const P2T10 = 0.0330810546875;
const P2T11 = -0.0189208984375;

const P3T0 = -0.0189208984375;
const P3T1 = 0.0330810546875;
const P3T2 = -0.0582275390625;
const P3T3 = 0.1015625000000;
const P3T4 = -0.2003173828125;
const P3T5 = 0.7797851562500;
const P3T6 = 0.4650878906250;
const P3T7 = -0.1665039062500;
const P3T8 = 0.0891113281250;
const P3T9 = -0.0517578125000;
const P3T10 = 0.0292968750000;
const P3T11 = -0.0291748046875;

export type TruePeakUpsamplingFactor = 4 | 8 | 16;

export class TruePeakUpsampler {
	readonly factor: TruePeakUpsamplingFactor;
	// Last HISTORY_LENGTH samples of prior input, oldest-first; prefixes `work` each chunk so the tap loop reads contiguously with no wraparound.
	private readonly history: Float64Array;
	private work: Float64Array = new Float64Array(0);

	constructor(factor: TruePeakUpsamplingFactor = 4) {
		if (factor !== 4) {
			throw new Error(`TruePeakUpsampler: factor ${factor} is not yet implemented; only 4× (BS.1770-4 Annex 1) is supported`);
		}

		this.factor = factor;
		this.history = new Float64Array(HISTORY_LENGTH_4X);
	}

	// `outputScratch` (>= input.length × factor) avoids the per-call allocation; the returned view aliases it.
	upsample(input: Float32Array, outputScratch?: Float32Array): Float32Array {
		const factor = this.factor;
		const inputLength = input.length;
		const outputLength = inputLength * factor;
		const output = outputScratch !== undefined && outputScratch.length >= outputLength
			? outputScratch.subarray(0, outputLength)
			: new Float32Array(outputLength);
		const history = this.history;
		const historyLength = HISTORY_LENGTH_4X;
		const workLength = historyLength + inputLength;

		if (this.work.length < workLength) {
			this.work = new Float64Array(workLength);
		}

		const work = this.work;

		work.set(history, 0);

		for (let inIdx = 0; inIdx < inputLength; inIdx++) {
			work[historyLength + inIdx] = input[inIdx] ?? 0;
		}

		// Unrolled per-phase 12-tap inner products; each acc starts at 0 and accumulates in tap
		// order 0..11 (most-recent-first), matching the original loop's fp sequence exactly.
		for (let inIdx = 0; inIdx < inputLength; inIdx++) {
			const currentIdx = historyLength + inIdx;
			const outOffset = inIdx * factor;

			output[outOffset] = input[inIdx] ?? 0;

			const v0 = work[currentIdx] ?? 0;
			const v1 = work[currentIdx - 1] ?? 0;
			const v2 = work[currentIdx - 2] ?? 0;
			const v3 = work[currentIdx - 3] ?? 0;
			const v4 = work[currentIdx - 4] ?? 0;
			const v5 = work[currentIdx - 5] ?? 0;
			const v6 = work[currentIdx - 6] ?? 0;
			const v7 = work[currentIdx - 7] ?? 0;
			const v8 = work[currentIdx - 8] ?? 0;
			const v9 = work[currentIdx - 9] ?? 0;
			const v10 = work[currentIdx - 10] ?? 0;
			const v11 = work[currentIdx - 11] ?? 0;

			let acc1 = 0;

			acc1 += P1T0 * v0;
			acc1 += P1T1 * v1;
			acc1 += P1T2 * v2;
			acc1 += P1T3 * v3;
			acc1 += P1T4 * v4;
			acc1 += P1T5 * v5;
			acc1 += P1T6 * v6;
			acc1 += P1T7 * v7;
			acc1 += P1T8 * v8;
			acc1 += P1T9 * v9;
			acc1 += P1T10 * v10;
			acc1 += P1T11 * v11;

			let acc2 = 0;

			acc2 += P2T0 * v0;
			acc2 += P2T1 * v1;
			acc2 += P2T2 * v2;
			acc2 += P2T3 * v3;
			acc2 += P2T4 * v4;
			acc2 += P2T5 * v5;
			acc2 += P2T6 * v6;
			acc2 += P2T7 * v7;
			acc2 += P2T8 * v8;
			acc2 += P2T9 * v9;
			acc2 += P2T10 * v10;
			acc2 += P2T11 * v11;

			let acc3 = 0;

			acc3 += P3T0 * v0;
			acc3 += P3T1 * v1;
			acc3 += P3T2 * v2;
			acc3 += P3T3 * v3;
			acc3 += P3T4 * v4;
			acc3 += P3T5 * v5;
			acc3 += P3T6 * v6;
			acc3 += P3T7 * v7;
			acc3 += P3T8 * v8;
			acc3 += P3T9 * v9;
			acc3 += P3T10 * v10;
			acc3 += P3T11 * v11;

			output[outOffset + 1] = acc1;
			output[outOffset + 2] = acc2;
			output[outOffset + 3] = acc3;
		}

		if (inputLength >= historyLength) {
			history.set(work.subarray(workLength - historyLength, workLength), 0);
		} else if (inputLength > 0) {
			history.copyWithin(0, inputLength);
			history.set(work.subarray(historyLength, workLength), historyLength - inputLength);
		}

		return output;
	}

	reset(): void {
		this.history.fill(0);
		this.work = new Float64Array(0);
	}
}
