import { describe, expect, it } from "vitest";
import { binaries, hasBinaryFixtures } from "../../../utils/test-binaries";
import { createOnnxSession } from "../../../utils/onnx-runtime";
import { BLOCK_SHIFT, DtlnBlockStream, WARMUP_SHIFTS, processDtlnFrames } from "./dtln";

// Whole-array and manual-streaming paths must be bit-identical; divergence means state leakage / OLA drift in `DtlnBlockStream`.
const describeIfFixtureSet = hasBinaryFixtures("model1", "model2", "onnxAddon") ? describe : describe.skip;

describeIfFixtureSet("DtlnBlockStream bit-exact equivalence", () => {
	it("DtlnBlockStream.step + flush matches processDtlnFrames bit-for-bit on a 1-second test signal", () => {
		const session1 = createOnnxSession(binaries.onnxAddon, binaries.model1, { executionProviders: ["cpu"] });
		const session2 = createOnnxSession(binaries.onnxAddon, binaries.model2, { executionProviders: ["cpu"] });

		try {
			// Deterministic LCG (fixed seed): broadband noise exercising the masking model without fixtures.
			const length = 16000;
			const signal = new Float32Array(length);
			let state = 0x12_34_56_78;

			for (let index = 0; index < length; index++) {
				state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
				signal[index] = (state / 0x80_00_00_00 - 1) * 0.3;
			}

			const reference = processDtlnFrames(signal, session1, session2);

			const BLOCK_LEN = 512;
			const effectiveLength = Math.max(length, BLOCK_LEN);
			const lastOffset = Math.floor((effectiveLength - BLOCK_LEN) / BLOCK_SHIFT) * BLOCK_SHIFT;
			const numBlocks = lastOffset / BLOCK_SHIFT + 1;
			const totalSteps = numBlocks + WARMUP_SHIFTS;

			const stream = new DtlnBlockStream({ session1, session2 });
			const stepOutputs: Array<Float32Array> = [];
			const stepInput = new Float32Array(BLOCK_SHIFT);

			for (let step = 0; step < totalSteps; step++) {
				const inputStart = step * BLOCK_SHIFT;
				const realAvail = Math.max(0, Math.min(BLOCK_SHIFT, length - inputStart));

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
			const streamed = new Float32Array(length);
			let writeIdx = 0;
			let skip = warmupSamples;

			for (const out of stepOutputs) {
				if (writeIdx >= length) break;
				if (skip >= out.length) {
					skip -= out.length;
					continue;
				}

				const start = skip;

				skip = 0;
				const take = Math.min(out.length - start, length - writeIdx);

				streamed.set(out.subarray(start, start + take), writeIdx);
				writeIdx += take;
			}

			if (writeIdx < length) {
				const take = Math.min(flushOutput.length, length - writeIdx);

				streamed.set(flushOutput.subarray(0, take), writeIdx);
				writeIdx += take;
			}

			expect(streamed.length).toBe(reference.length);

			// Bit-exact: no tolerance.
			let firstDiff = -1;

			for (let index = 0; index < length; index++) {
				if (streamed[index] !== reference[index]) {
					firstDiff = index;
					break;
				}
			}

			expect(firstDiff).toBe(-1);
		} finally {
			session1.dispose();
			session2.dispose();
		}
	}, 60_000);
});
