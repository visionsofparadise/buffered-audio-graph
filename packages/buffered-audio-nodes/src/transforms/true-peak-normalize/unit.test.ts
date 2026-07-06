/* eslint-disable no-console -- the node logs a measurement summary by design; tests run with vitest, console output is fine in CI. */
import { describe, expect, it } from "vitest";
import { TruePeakAccumulator } from "@buffered-audio/utils";
import { type Block } from "@buffered-audio/core";
import { schema, truePeakNormalize, TruePeakNormalizeStream } from ".";

const TEST_SAMPLE_RATE = 48_000;
const TEST_FRAMES = TEST_SAMPLE_RATE;

function measureTruePeak(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const accumulator = new TruePeakAccumulator(sampleRate, channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return accumulator.finalize();
}

function makeSine(freq: number, frames: number, sampleRate: number, amplitude: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		out[index] = Math.sin((2 * Math.PI * freq * index) / sampleRate) * amplitude;
	}

	return out;
}

function makeSilence(frames: number): Float32Array {
	return new Float32Array(frames);
}

function samplePeak(channels: ReadonlyArray<Float32Array>): number {
	let max = 0;

	for (const channel of channels) {
		for (let index = 0; index < channel.length; index++) {
			const absolute = Math.abs(channel[index] ?? 0);

			if (absolute > max) max = absolute;
		}
	}

	return max;
}

interface StreamRunOptions {
	target: number;
	chunkFrames?: number;
}

async function runStream(channels: ReadonlyArray<Float32Array>, sampleRate: number, options: StreamRunOptions): Promise<Array<Float32Array>> {
	const channelCount = channels.length;
	const stream = new TruePeakNormalizeStream({
		target: options.target,
		bufferSize: Infinity,
		overlap: 0,
	});
	const transformStream = stream.createTransformStream();
	const writer = transformStream.writable.getWriter();
	const reader = transformStream.readable.getReader();

	const drain = (async () => {
		const collected: Array<Array<Float32Array>> = [];

		while (true) {
			const next = await reader.read();

			if (next.done) return collected;

			collected.push(next.value.samples);
		}
	})();

	const totalFrames = channels[0]?.length ?? 0;
	const chunkFrames = options.chunkFrames ?? totalFrames;
	let offset = 0;

	if (totalFrames === 0) {
		// Still need a chunk to advance the stream; send empty.
		const samples: Array<Float32Array> = channels.map(() => new Float32Array(0));
		const chunk: Block = { samples, offset: 0, sampleRate, bitDepth: 32 };

		await writer.write(chunk);
	} else {
		while (offset < totalFrames) {
			const take = Math.min(chunkFrames, totalFrames - offset);
			const samples: Array<Float32Array> = channels.map((channel) => channel.slice(offset, offset + take));
			const chunk: Block = { samples, offset, sampleRate, bitDepth: 32 };

			await writer.write(chunk);
			offset += take;
		}
	}

	await writer.close();

	const collected = await drain;

	const lengths = new Array<number>(channelCount).fill(0);

	for (const piece of collected) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			lengths[channelIndex] = (lengths[channelIndex] ?? 0) + (piece[channelIndex]?.length ?? 0);
		}
	}

	const out: Array<Float32Array> = [];

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		out.push(new Float32Array(lengths[channelIndex] ?? 0));
	}

	const offsets = new Array<number>(channelCount).fill(0);

	for (const piece of collected) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const slice = piece[channelIndex];

			if (!slice) continue;

			out[channelIndex]?.set(slice, offsets[channelIndex] ?? 0);
			offsets[channelIndex] = (offsets[channelIndex] ?? 0) + slice.length;
		}
	}

	return out;
}

describe("truePeakNormalize - schema", () => {
	it("parses an empty options object using the default target -1 dBTP", () => {
		const parsed = schema.parse({});

		expect(parsed.target).toBe(-1);
	});

	it("rejects target = 0 (lt(0) constraint)", () => {
		expect(() => schema.parse({ target: 0 })).toThrow();
	});

	it("rejects positive target", () => {
		expect(() => schema.parse({ target: 0.5 })).toThrow();
	});

	it("accepts negative target overrides", () => {
		expect(schema.parse({ target: -3 }).target).toBe(-3);
		expect(schema.parse({ target: -0.1 }).target).toBe(-0.1);
	});

	it("factory function builds a node with the parsed default", () => {
		const node = truePeakNormalize();

		expect(node.properties.target).toBe(-1);
	});
});

describe("truePeakNormalize - apply", () => {
	const TEST_TIMEOUT_MS = 30_000;
	const TARGET_TOLERANCE_DB = 0.05;

	it("normalises a source peak below target up to the target true peak", async () => {
		// Source true peak ≈ 0.5 (a 1 kHz sine at amplitude 0.5 has
		// minimal intersample lift). Target -1 dBTP ⇒ output true peak
		// should be 10^(-1/20) ≈ 0.891.
		const target = -1;
		const expectedLinear = Math.pow(10, target / 20);
		const input = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.5);
		const measuredSourceTp = measureTruePeak([input], TEST_SAMPLE_RATE);
		const expectedGain = expectedLinear / measuredSourceTp;

		const [output] = await runStream([input], TEST_SAMPLE_RATE, { target });

		expect(output).toBeDefined();
		expect(output!.length).toBe(input.length);

		const measuredOutputTp = measureTruePeak([output!], TEST_SAMPLE_RATE);
		const measuredOutputDb = 20 * Math.log10(measuredOutputTp);

		expect(Math.abs(measuredOutputDb - target)).toBeLessThan(TARGET_TOLERANCE_DB);

		// Spot-check a few samples to confirm the gain was applied as a
		// uniform linear factor (no oversampling at apply time).
		for (const index of [0, 100, 1234, TEST_FRAMES - 1]) {
			const expected = (input[index] ?? 0) * expectedGain;
			const actual = output![index] ?? 0;

			expect(Math.abs(actual - expected)).toBeLessThan(1e-5);
		}
	}, TEST_TIMEOUT_MS);

	it("amplifies a quiet source to hit the target", async () => {
		// Source true peak ≈ 0.1 (-20 dBTP). Target -1 dBTP ⇒ +19 dB
		// uniform gain.
		const target = -1;
		const input = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.1);

		const [output] = await runStream([input], TEST_SAMPLE_RATE, { target });

		const measuredOutputTp = measureTruePeak([output!], TEST_SAMPLE_RATE);
		const measuredOutputDb = 20 * Math.log10(measuredOutputTp);

		expect(Math.abs(measuredOutputDb - target)).toBeLessThan(TARGET_TOLERANCE_DB);
		// And the source sample peak (0.1) should have moved up relative
		// to its starting position — confirms amplification rather than
		// pass-through.
		expect(samplePeak([output!])).toBeGreaterThan(0.5);
	}, TEST_TIMEOUT_MS);

	it("attenuates a hot source to hit a lower target", async () => {
		// Source near ceiling. Target -3 dBTP ⇒ output should drop.
		const target = -3;
		const expectedLinear = Math.pow(10, target / 20);
		const input = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.95);

		const [output] = await runStream([input], TEST_SAMPLE_RATE, { target });

		const measuredOutputTp = measureTruePeak([output!], TEST_SAMPLE_RATE);
		const measuredOutputDb = 20 * Math.log10(measuredOutputTp);

		expect(Math.abs(measuredOutputDb - target)).toBeLessThan(TARGET_TOLERANCE_DB);
		// And the output sample peak should be ≈ expectedLinear (within
		// intersample-lift slack).
		expect(samplePeak([output!])).toBeLessThan(expectedLinear + 0.05);
		expect(samplePeak([output!])).toBeLessThan(0.95);
	}, TEST_TIMEOUT_MS);

	it("normalises stereo against the cross-channel max true peak", async () => {
		// Per BS.1770, true peak is `max(|x|)` across ALL channels — a
		// single value. The louder channel should land at the target;
		// the quieter channel scales by the same gain factor.
		const target = -1;
		const expectedLinear = Math.pow(10, target / 20);
		const left = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.3);
		const right = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.7);
		const sourceTp = measureTruePeak([left, right], TEST_SAMPLE_RATE);
		const expectedGain = expectedLinear / sourceTp;

		const [outL, outR] = await runStream([left, right], TEST_SAMPLE_RATE, { target });

		expect(outL).toBeDefined();
		expect(outR).toBeDefined();

		const outputTp = measureTruePeak([outL!, outR!], TEST_SAMPLE_RATE);
		const outputDb = 20 * Math.log10(outputTp);

		expect(Math.abs(outputDb - target)).toBeLessThan(TARGET_TOLERANCE_DB);

		// Both channels scaled by the same gain factor (uniform across
		// all channels — that's what makes this a true normalize, not
		// a per-channel one).
		const leftRatio = (outL![1234] ?? 0) / (left[1234] ?? 1);
		const rightRatio = (outR![1234] ?? 0) / (right[1234] ?? 1);

		expect(Math.abs(leftRatio - expectedGain)).toBeLessThan(1e-4);
		expect(Math.abs(rightRatio - expectedGain)).toBeLessThan(1e-4);
	}, TEST_TIMEOUT_MS);

	it("passes silence through cleanly (no NaN, no division by zero)", async () => {
		// Source true peak = 0; dB = -Infinity; gain formula divides by
		// zero. The node guards this and passes input through unchanged
		// (gain = 1). Output stays all zeros, no NaN/Inf escapes.
		const input = makeSilence(TEST_FRAMES);

		const [output] = await runStream([input], TEST_SAMPLE_RATE, { target: -1 });

		expect(output).toBeDefined();
		expect(output!.length).toBe(input.length);

		for (let index = 0; index < output!.length; index++) {
			const sample = output![index] ?? 0;

			expect(Number.isFinite(sample)).toBe(true);
			expect(sample).toBe(0);
		}
	}, TEST_TIMEOUT_MS);

	it("matches single-chunk output when input is split across chunks", async () => {
		// The apply pass is a uniform per-sample multiply; the only thing
		// that could differ between single-chunk and multi-chunk is the
		// measurement pass — but the buffer is fully buffered before
		// `_process` runs (WHOLE_FILE bufferSize), so both runs see the
		// same source. Outputs must be sample-identical.
		const target = -1;
		const input = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.5);

		const [whole] = await runStream([input], TEST_SAMPLE_RATE, { target });
		const [chunked] = await runStream([input], TEST_SAMPLE_RATE, { target, chunkFrames: 4096 });

		expect(whole).toBeDefined();
		expect(chunked).toBeDefined();
		expect(whole!.length).toBe(chunked!.length);

		for (let index = 0; index < whole!.length; index++) {
			const a = whole![index] ?? 0;
			const b = chunked![index] ?? 0;

			expect(Math.abs(a - b)).toBeLessThan(1e-6);
		}
	}, TEST_TIMEOUT_MS);
});
