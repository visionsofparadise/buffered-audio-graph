import { istft, stft, type FftBackend } from "@buffered-audio/utils";
import type { OnnxSession } from "../../../utils/onnx-runtime";

const BLOCK_LEN = 512;
const BLOCK_SHIFT = 128;
const FFT_BINS = BLOCK_LEN / 2 + 1;
const LSTM_UNITS = 128;
const STATE_SIZE = 1 * 2 * LSTM_UNITS * 2;
const WARMUP_SHIFTS = BLOCK_LEN / BLOCK_SHIFT - 1; // 3

export { BLOCK_LEN, BLOCK_SHIFT, WARMUP_SHIFTS };

export class DtlnBlockStream {
	private readonly session1: OnnxSession;
	private readonly session2: OnnxSession;
	private readonly fftBackend?: FftBackend;
	private readonly fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	private states1: Float32Array = new Float32Array(STATE_SIZE);
	private states2: Float32Array = new Float32Array(STATE_SIZE);

	private readonly inputBuffer: Float32Array = new Float32Array(BLOCK_LEN);
	private inputFilled = 0;

	private readonly olaScratch: Float32Array = new Float32Array(BLOCK_LEN);
	private readonly magnitude: Float32Array = new Float32Array(FFT_BINS);
	private readonly maskedReal: Float32Array = new Float32Array(FFT_BINS);
	private readonly maskedImag: Float32Array = new Float32Array(FFT_BINS);
	private readonly stftRealScratch: Float32Array = new Float32Array(FFT_BINS);
	private readonly stftImagScratch: Float32Array = new Float32Array(FFT_BINS);
	private readonly maskedStft: { real: Float32Array; imag: Float32Array; frames: number; fftSize: number };
	private readonly stftOutput: { real: Float32Array; imag: Float32Array };

	constructor(args: {
		readonly session1: OnnxSession;
		readonly session2: OnnxSession;
		readonly fftBackend?: FftBackend;
		readonly fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	}) {
		this.session1 = args.session1;
		this.session2 = args.session2;
		this.fftBackend = args.fftBackend;
		this.fftAddonOptions = args.fftAddonOptions;

		this.maskedStft = {
			real: this.maskedReal,
			imag: this.maskedImag,
			frames: 1,
			fftSize: BLOCK_LEN,
		};
		this.stftOutput = { real: this.stftRealScratch, imag: this.stftImagScratch };
	}

	step(inputBlock: Float32Array): Float32Array {
		if (inputBlock.length !== BLOCK_SHIFT) {
			throw new Error(`DtlnBlockStream.step: expected ${String(BLOCK_SHIFT)} samples, got ${String(inputBlock.length)}`);
		}

		this.inputBuffer.copyWithin(0, BLOCK_SHIFT, BLOCK_LEN);
		this.inputBuffer.set(inputBlock, BLOCK_LEN - BLOCK_SHIFT);

		if (this.inputFilled < BLOCK_LEN) {
			this.inputFilled += BLOCK_SHIFT;

			if (this.inputFilled >= BLOCK_LEN) {
				this.inputFilled = BLOCK_LEN;
				this.runBlock();
			}
		} else {
			this.runBlock();
		}

		const out = new Float32Array(BLOCK_SHIFT);

		out.set(this.olaScratch.subarray(0, BLOCK_SHIFT));

		this.olaScratch.copyWithin(0, BLOCK_SHIFT, BLOCK_LEN);
		this.olaScratch.fill(0, BLOCK_LEN - BLOCK_SHIFT, BLOCK_LEN);

		return out;
	}

	flush(): Float32Array {
		const remaining = BLOCK_LEN - BLOCK_SHIFT;
		const out = new Float32Array(remaining);

		out.set(this.olaScratch.subarray(0, remaining));

		return out;
	}

	private runBlock(): void {
		const stftResult = stft(this.inputBuffer, BLOCK_LEN, BLOCK_LEN, this.stftOutput, this.fftBackend, this.fftAddonOptions);

		if (stftResult.frames < 1) return;

		for (let bin = 0; bin < FFT_BINS; bin++) {
			const re = stftResult.real[bin] ?? 0;
			const im = stftResult.imag[bin] ?? 0;

			this.magnitude[bin] = Math.log(Math.sqrt(re * re + im * im) + 1e-7);
		}

		const result1 = this.session1.run({
			input_2: { data: this.magnitude, dims: [1, 1, FFT_BINS] },
			input_3: { data: this.states1, dims: [1, 2, LSTM_UNITS, 2] },
		});

		const mask = result1.activation_2;

		this.states1 = result1.tf_op_layer_stack_2 ? new Float32Array(result1.tf_op_layer_stack_2.data) : this.states1;

		if (!mask) return;

		for (let bin = 0; bin < FFT_BINS; bin++) {
			const maskVal = mask.data[bin] ?? 0;

			this.maskedReal[bin] = (stftResult.real[bin] ?? 0) * maskVal;
			this.maskedImag[bin] = (stftResult.imag[bin] ?? 0) * maskVal;
		}

		const maskedTimeDomain = istft(this.maskedStft, BLOCK_LEN, BLOCK_LEN, this.fftBackend, this.fftAddonOptions);

		const result2 = this.session2.run({
			input_4: { data: maskedTimeDomain, dims: [1, 1, BLOCK_LEN] },
			input_5: { data: this.states2, dims: [1, 2, LSTM_UNITS, 2] },
		});

		const denoisedFrame = result2.conv1d_3;

		this.states2 = result2.tf_op_layer_stack_5 ? new Float32Array(result2.tf_op_layer_stack_5.data) : this.states2;

		if (!denoisedFrame) return;

		for (let index = 0; index < BLOCK_LEN; index++) {
			this.olaScratch[index] = (this.olaScratch[index] ?? 0) + (denoisedFrame.data[index] ?? 0);
		}
	}
}

export function processDtlnFrames(
	signal: Float32Array,
	session1: OnnxSession,
	session2: OnnxSession,
	fftBackend?: FftBackend,
	fftAddonOptions?: { vkfftPath?: string; fftwPath?: string },
): Float32Array {
	const originalLength = signal.length;
	const effectiveLength = Math.max(originalLength, BLOCK_LEN);
	const lastOffset = Math.floor((effectiveLength - BLOCK_LEN) / BLOCK_SHIFT) * BLOCK_SHIFT;
	const numBlocks = lastOffset / BLOCK_SHIFT + 1;
	const totalSteps = numBlocks + WARMUP_SHIFTS;

	const stream = new DtlnBlockStream({ session1, session2, fftBackend, fftAddonOptions });
	const stepOutputs: Array<Float32Array> = [];
	const stepInput = new Float32Array(BLOCK_SHIFT);

	for (let step = 0; step < totalSteps; step++) {
		const inputStart = step * BLOCK_SHIFT;
		const realAvail = Math.max(0, Math.min(BLOCK_SHIFT, originalLength - inputStart));

		if (realAvail > 0) {
			stepInput.set(signal.subarray(inputStart, inputStart + realAvail));
		}

		if (realAvail < BLOCK_SHIFT) {
			stepInput.fill(0, realAvail, BLOCK_SHIFT);
		}

		stepOutputs.push(stream.step(stepInput));
	}

	const flushOutput = stream.flush();
	const warmupSamples = WARMUP_SHIFTS * BLOCK_SHIFT;
	const output = new Float32Array(originalLength);
	let writeIdx = 0;
	let skip = warmupSamples;
	const needed = originalLength;

	for (const out of stepOutputs) {
		if (writeIdx >= needed) break;
		if (skip >= out.length) {
			skip -= out.length;
			continue;
		}

		const start = skip;

		skip = 0;
		const take = Math.min(out.length - start, needed - writeIdx);

		output.set(out.subarray(start, start + take), writeIdx);
		writeIdx += take;
	}

	if (writeIdx < needed) {
		const take = Math.min(flushOutput.length, needed - writeIdx);

		output.set(flushOutput.subarray(0, take), writeIdx);
		writeIdx += take;
	}

	return output;
}
