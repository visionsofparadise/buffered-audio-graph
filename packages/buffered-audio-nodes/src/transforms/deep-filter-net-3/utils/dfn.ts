import type { OnnxSession } from "../../../utils/onnx-runtime";

export const DFN3_SAMPLE_RATE = 48000;
export const DFN3_HOP_SIZE = 480;
export const DFN3_FFT_SIZE = 960;
export const DFN3_STATE_SIZE = 45304;

export interface DfnState {
	state: Float32Array;
	atten: Float32Array;
}

export function createDfnState(): DfnState {
	return {
		state: new Float32Array(DFN3_STATE_SIZE),
		atten: new Float32Array(1),
	};
}

export function processDfnBlock(dfnState: DfnState, signal: Float32Array, session: OnnxSession, attenLimDb: number): Float32Array {
	const originalLength = signal.length;
	const hopRemainder = originalLength % DFN3_HOP_SIZE;
	const paddedLength = hopRemainder === 0 ? originalLength : originalLength + (DFN3_HOP_SIZE - hopRemainder);
	const padded = paddedLength === originalLength ? signal : new Float32Array(paddedLength);

	if (padded !== signal) {
		padded.set(signal);
	}

	const numFrames = paddedLength / DFN3_HOP_SIZE;
	const output = new Float32Array(originalLength);
	const { state, atten } = dfnState;

	atten[0] = attenLimDb;

	for (let frameIndex = 0; frameIndex < numFrames; frameIndex++) {
		const offset = frameIndex * DFN3_HOP_SIZE;
		const inputFrame = padded.subarray(offset, offset + DFN3_HOP_SIZE);

		const result = session.run({
			input_frame: { data: inputFrame, dims: [DFN3_HOP_SIZE] },
			states: { data: state, dims: [DFN3_STATE_SIZE] },
			atten_lim_db: { data: atten, dims: [1] },
		});

		const enhanced = result.enhanced_audio_frame;
		const newStates = result.new_states;

		if (enhanced) {
			const outFrame = enhanced.data;
			const writeStart = offset;
			// Trim against originalLength so the final partial block doesn't write past the buffer (padded zeros inferred, not emitted).
			const writeEnd = Math.min(writeStart + DFN3_HOP_SIZE, originalLength);
			const copyLen = writeEnd - writeStart;

			for (let index = 0; index < copyLen; index++) {
				output[writeStart + index] = outFrame[index] ?? 0;
			}
		}

		if (newStates) {
			state.set(newStates.data);
		}
	}

	return output;
}

