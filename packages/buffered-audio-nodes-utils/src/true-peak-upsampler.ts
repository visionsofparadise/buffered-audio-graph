// Four-phase, 12-tap FIR coefficient columns from ITU-R BS.1770-5 Annex 2.

const TAPS_PER_PHASE_4X = 12;
const HISTORY_LENGTH_4X = TAPS_PER_PHASE_4X;
const FLUSH_INPUT_4X = new Float32Array(TAPS_PER_PHASE_4X - 1);

const P0T0 = 0.0017089843750;
const P0T1 = 0.0109863281250;
const P0T2 = -0.0196533203125;
const P0T3 = 0.0332031250000;
const P0T4 = -0.0594482421875;
const P0T5 = 0.1373291015625;
const P0T6 = 0.9721679687500;
const P0T7 = -0.1022949218750;
const P0T8 = 0.0476074218750;
const P0T9 = -0.0266113281250;
const P0T10 = 0.0148925781250;
const P0T11 = -0.0083007812500;

const P1T0 = -0.0291748046875;
const P1T1 = 0.0292968750000;
const P1T2 = -0.0517578125000;
const P1T3 = 0.0891113281250;
const P1T4 = -0.1665039062500;
const P1T5 = 0.4650878906250;
const P1T6 = 0.7797851562500;
const P1T7 = -0.2003173828125;
const P1T8 = 0.1015625000000;
const P1T9 = -0.0582275390625;
const P1T10 = 0.0330810546875;
const P1T11 = -0.0189208984375;

const P2T0 = -0.0189208984375;
const P2T1 = 0.0330810546875;
const P2T2 = -0.0582275390625;
const P2T3 = 0.1015625000000;
const P2T4 = -0.2003173828125;
const P2T5 = 0.7797851562500;
const P2T6 = 0.4650878906250;
const P2T7 = -0.1665039062500;
const P2T8 = 0.0891113281250;
const P2T9 = -0.0517578125000;
const P2T10 = 0.0292968750000;
const P2T11 = -0.0291748046875;

const P3T0 = -0.0083007812500;
const P3T1 = 0.0148925781250;
const P3T2 = -0.0266113281250;
const P3T3 = 0.0476074218750;
const P3T4 = -0.1022949218750;
const P3T5 = 0.9721679687500;
const P3T6 = 0.1373291015625;
const P3T7 = -0.0594482421875;
const P3T8 = 0.0332031250000;
const P3T9 = -0.0196533203125;
const P3T10 = 0.0109863281250;
const P3T11 = 0.0017089843750;

export type TruePeakUpsamplingFactor = 4 | 8 | 16;

export class TruePeakUpsampler {
	readonly factor: TruePeakUpsamplingFactor;
	private readonly history: Float64Array;
	private work: Float64Array = new Float64Array(0);
	private flushed = false;

	constructor(factor: TruePeakUpsamplingFactor = 4) {
		if (factor !== 4) {
			throw new Error(`TruePeakUpsampler: factor ${factor} is not yet implemented; only 4× (BS.1770-5 Annex 2) is supported`);
		}

		this.factor = factor;
		this.history = new Float64Array(HISTORY_LENGTH_4X);
	}

	upsample(input: Float32Array, outputScratch?: Float32Array): Float32Array {
		if (this.flushed) throw new Error("TruePeakUpsampler: upsample after flush; call reset() first");

		return this.process(input, outputScratch);
	}

	flush(outputScratch?: Float32Array): Float32Array {
		if (this.flushed) return new Float32Array(0);

		const output = this.process(FLUSH_INPUT_4X, outputScratch);

		this.flushed = true;

		return output;
	}

	reset(): void {
		this.history.fill(0);
		this.work = new Float64Array(0);
		this.flushed = false;
	}

	private process(input: Float32Array, outputScratch?: Float32Array): Float32Array {
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

		for (let inputIndex = 0; inputIndex < inputLength; inputIndex++) {
			work[historyLength + inputIndex] = input[inputIndex] ?? 0;
		}

		for (let inputIndex = 0; inputIndex < inputLength; inputIndex++) {
			const currentIndex = historyLength + inputIndex;
			const outputOffset = inputIndex * factor;
			const value0 = work[currentIndex] ?? 0;
			const value1 = work[currentIndex - 1] ?? 0;
			const value2 = work[currentIndex - 2] ?? 0;
			const value3 = work[currentIndex - 3] ?? 0;
			const value4 = work[currentIndex - 4] ?? 0;
			const value5 = work[currentIndex - 5] ?? 0;
			const value6 = work[currentIndex - 6] ?? 0;
			const value7 = work[currentIndex - 7] ?? 0;
			const value8 = work[currentIndex - 8] ?? 0;
			const value9 = work[currentIndex - 9] ?? 0;
			const value10 = work[currentIndex - 10] ?? 0;
			const value11 = work[currentIndex - 11] ?? 0;
			let phase0 = 0;

			phase0 += P0T0 * value0;
			phase0 += P0T1 * value1;
			phase0 += P0T2 * value2;
			phase0 += P0T3 * value3;
			phase0 += P0T4 * value4;
			phase0 += P0T5 * value5;
			phase0 += P0T6 * value6;
			phase0 += P0T7 * value7;
			phase0 += P0T8 * value8;
			phase0 += P0T9 * value9;
			phase0 += P0T10 * value10;
			phase0 += P0T11 * value11;

			let phase1 = 0;

			phase1 += P1T0 * value0;
			phase1 += P1T1 * value1;
			phase1 += P1T2 * value2;
			phase1 += P1T3 * value3;
			phase1 += P1T4 * value4;
			phase1 += P1T5 * value5;
			phase1 += P1T6 * value6;
			phase1 += P1T7 * value7;
			phase1 += P1T8 * value8;
			phase1 += P1T9 * value9;
			phase1 += P1T10 * value10;
			phase1 += P1T11 * value11;

			let phase2 = 0;

			phase2 += P2T0 * value0;
			phase2 += P2T1 * value1;
			phase2 += P2T2 * value2;
			phase2 += P2T3 * value3;
			phase2 += P2T4 * value4;
			phase2 += P2T5 * value5;
			phase2 += P2T6 * value6;
			phase2 += P2T7 * value7;
			phase2 += P2T8 * value8;
			phase2 += P2T9 * value9;
			phase2 += P2T10 * value10;
			phase2 += P2T11 * value11;

			let phase3 = 0;

			phase3 += P3T0 * value0;
			phase3 += P3T1 * value1;
			phase3 += P3T2 * value2;
			phase3 += P3T3 * value3;
			phase3 += P3T4 * value4;
			phase3 += P3T5 * value5;
			phase3 += P3T6 * value6;
			phase3 += P3T7 * value7;
			phase3 += P3T8 * value8;
			phase3 += P3T9 * value9;
			phase3 += P3T10 * value10;
			phase3 += P3T11 * value11;

			output[outputOffset] = phase0;
			output[outputOffset + 1] = phase1;
			output[outputOffset + 2] = phase2;
			output[outputOffset + 3] = phase3;
		}

		if (inputLength >= historyLength) {
			history.set(work.subarray(workLength - historyLength, workLength), 0);
		} else if (inputLength > 0) {
			history.copyWithin(0, inputLength);
			history.set(work.subarray(historyLength, workLength), historyLength - inputLength);
		}

		return output;
	}
}
