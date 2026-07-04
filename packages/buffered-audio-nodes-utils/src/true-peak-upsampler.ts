// Coefficients from the libebur128 reference `interpolator.c` (`g_true_peak_4x_coefficients`), mirroring BS.1770-4 Annex 1 table 4. https://github.com/jiixyj/libebur128

const TAPS_PER_PHASE_4X = 12;
const HISTORY_LENGTH_4X = TAPS_PER_PHASE_4X;

// libebur128 `ebur128.c` (`interp_create` / `g_true_peak_4x_coefficients`), a literal transcription of BS.1770-4 Annex 1.
const COEFFICIENTS_4X: ReadonlyArray<ReadonlyArray<number>> = [
	[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
	[
		0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000,
		-0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750,
		0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500,
	],
	[
		-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250,
		-0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125,
		0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375,
	],
	[
		-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000,
		-0.2003173828125, 0.7797851562500, 0.4650878906250, -0.1665039062500,
		0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875,
	],
];

export type TruePeakUpsamplingFactor = 4 | 8 | 16;

export class TruePeakUpsampler {
	readonly factor: TruePeakUpsamplingFactor;
	private readonly history: Float64Array;
	private writeIndex = 0;

	constructor(factor: TruePeakUpsamplingFactor = 4) {
		if (factor !== 4) {
			throw new Error(`TruePeakUpsampler: factor ${factor} is not yet implemented; only 4× (BS.1770-4 Annex 1) is supported`);
		}

		this.factor = factor;
		this.history = new Float64Array(HISTORY_LENGTH_4X);
	}

	upsample(input: Float32Array): Float32Array {
		const factor = this.factor;
		const inputLength = input.length;
		const output = new Float32Array(inputLength * factor);
		const history = this.history;
		const historyLength = HISTORY_LENGTH_4X;
		let writeIndex = this.writeIndex;

		for (let inIdx = 0; inIdx < inputLength; inIdx++) {
			const sample = input[inIdx] ?? 0;

			history[writeIndex] = sample;
			writeIndex = (writeIndex + 1) % historyLength;

			const outOffset = inIdx * factor;

			output[outOffset] = sample;

			for (let phase = 1; phase < factor; phase++) {
				const taps = COEFFICIENTS_4X[phase];

				if (taps === undefined) continue;

				let acc = 0;

				let readIndex = writeIndex - 1;

				if (readIndex < 0) readIndex += historyLength;

				for (let tap = 0; tap < historyLength; tap++) {
					acc += (taps[tap] ?? 0) * (history[readIndex] ?? 0);

					readIndex -= 1;

					if (readIndex < 0) readIndex += historyLength;
				}

				output[outOffset + phase] = acc;
			}
		}

		this.writeIndex = writeIndex;

		return output;
	}

	reset(): void {
		this.history.fill(0);
		this.writeIndex = 0;
	}
}
