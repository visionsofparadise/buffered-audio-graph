import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WaveFile } from "wavefile";
import { IntegratedLufsAccumulator } from "@buffered-audio/utils";
import { read } from "../../sources/read";
import { write } from "../../targets/write";
import { loudnessNormalize, LoudnessNormalizeStream } from ".";

const TEST_SAMPLE_RATE = 48_000;
const TEST_FRAMES = TEST_SAMPLE_RATE * 4; // 4 s — long enough for BS.1770 gating

function measureLufs(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const accumulator = new IntegratedLufsAccumulator(sampleRate, channels.length);

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

async function readBack32f(path: string): Promise<{ samples: Float32Array; sampleRate: number; channels: number }> {
	const file = new WaveFile();
	const data = await readFile(path);

	file.fromBuffer(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

	const fmt = file.fmt as { sampleRate: number; numChannels: number };
	const raw = file.getSamples(false, Float64Array) as unknown;
	const channels = fmt.numChannels;

	if (channels === 1) {
		const single = raw as Float64Array;
		const out = new Float32Array(single.length);

		for (let index = 0; index < single.length; index++) out[index] = single[index] ?? 0;

		return { samples: out, sampleRate: fmt.sampleRate, channels };
	}

	// Multi-channel: wavefile returns Array<Float64Array> (one per channel).
	const perChannel = raw as Array<Float64Array>;
	const length = perChannel[0]?.length ?? 0;
	const out = new Float32Array(length);

	for (let index = 0; index < length; index++) out[index] = perChannel[0]?.[index] ?? 0;

	return { samples: out, sampleRate: fmt.sampleRate, channels };
}

async function runNormalize(input: Float32Array, sampleRate: number, target: number): Promise<Float32Array> {
	const dir = join(tmpdir(), `ban-loudness-normalize-${randomBytes(6).toString("hex")}`);

	await mkdir(dir, { recursive: true });

	const inputPath = join(dir, "input.wav");
	const outputPath = join(dir, "output.wav");

	const inputWav = new WaveFile();

	inputWav.fromScratch(1, sampleRate, "32f", [input]);
	await writeFile(inputPath, Buffer.from(inputWav.toBuffer()));

	try {
		const source = read(inputPath);
		const node = loudnessNormalize({ target });
		const target_ = write(outputPath, { bitDepth: "32f" });

		source.to(node);
		node.to(target_);
		await source.render();

		const result = await readBack32f(outputPath);

		return result.samples;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("LoudnessNormalize", () => {
	const TEST_TIMEOUT_MS = 60_000;

	it("applies output[n] = input[n] × G to floating-point precision", async () => {
		// Pick a small synthetic input. Compute the expected gain by running
		// the same BS.1770 measurement against the input directly, then
		// assert each output sample matches input × G exactly (within float
		// rounding noise).
		const target = -16;
		const input = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.1);
		const measured = measureLufs([input], TEST_SAMPLE_RATE);
		const expectedGain = Math.pow(10, (target - measured) / 20);

		const output = await runNormalize(input, TEST_SAMPLE_RATE, target);

		expect(output.length).toBe(input.length);

		// Spot-check a handful of points across the buffer; every output
		// sample should equal input × G to within Float32 rounding.
		const probes = [0, 100, 1000, 12345, TEST_FRAMES - 1];

		for (const index of probes) {
			const expected = (input[index] ?? 0) * expectedGain;
			const actual = output[index] ?? 0;

			expect(Math.abs(actual - expected)).toBeLessThan(1e-5);
		}
	}, TEST_TIMEOUT_MS);

	it("output integrated LUFS lands within 0.1 dB of target across multiple targets", async () => {
		const input = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.1);

		for (const target of [-23, -16, -10]) {
			const output = await runNormalize(input, TEST_SAMPLE_RATE, target);
			const measured = measureLufs([output], TEST_SAMPLE_RATE);

			expect(Math.abs(measured - target)).toBeLessThan(0.1);
		}
	}, TEST_TIMEOUT_MS);

	it("produces a 32-bit-float-safe signal with peaks > 1.0 — no NaN/Inf, peak = inputPeak × G", async () => {
		// High-peak input + aggressive (loud) target → output peak is forced
		// above unity. Verify nothing saturates to ±1.0 and the peak matches
		// the algebraic expectation.
		const target = -3;
		const inputPeak = 0.9;
		const input = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, inputPeak);
		const measured = measureLufs([input], TEST_SAMPLE_RATE);
		const expectedGain = Math.pow(10, (target - measured) / 20);
		const expectedPeak = inputPeak * expectedGain;

		// Sanity: this configuration is supposed to push peaks above unity.
		expect(expectedPeak).toBeGreaterThan(1.0);

		const output = await runNormalize(input, TEST_SAMPLE_RATE, target);

		let observedPeak = 0;
		let saw1 = false;

		for (let index = 0; index < output.length; index++) {
			const sample = output[index] ?? 0;

			expect(Number.isFinite(sample)).toBe(true);

			const absolute = Math.abs(sample);

			if (absolute > observedPeak) observedPeak = absolute;
			if (absolute >= 1.0) saw1 = true;
		}

		expect(saw1).toBe(true);
		expect(Math.abs(observedPeak - expectedPeak)).toBeLessThan(1e-3);
	}, TEST_TIMEOUT_MS);

	it("renders end-to-end with no ffmpeg involvement", async () => {
		// The whole point of the migration: no ffmpeg subprocess. ESM
		// module-namespace exports can't be patched at runtime in vitest
		// (`Cannot redefine property: spawn`), so spying on
		// `child_process.spawn` from this test isn't viable. Instead, drive
		// the stream directly via its `TransformStream` surface — no source
		// or target nodes are involved, no `ffmpegPath` is supplied
		// anywhere in the schema, and the node has no code path that would
		// reach `child_process`. If a future change adds one it has to add
		// an `ffmpegPath` field to the schema (the only place the package
		// resolves an ffmpeg binary), which would be visible in review.
		const input = makeSine(1000, TEST_FRAMES, TEST_SAMPLE_RATE, 0.1);
		const stream = new LoudnessNormalizeStream({ target: -16, bufferSize: Infinity, overlap: 0 });
		const transformStream = stream.createTransformStream();
		const writer = transformStream.writable.getWriter();
		const reader = transformStream.readable.getReader();

		// Drain the readable concurrently with the writer. Awaiting
		// `writer.close()` before reading deadlocks: closing triggers the
		// flush handler which back-pressures on `controller.enqueue` until
		// the reader consumes.
		const drain = (async () => {
			const collected: Array<Float32Array> = [];

			while (true) {
				const next = await reader.read();

				if (next.done) return collected;

				const channel = next.value.samples[0];

				if (channel) collected.push(channel);
			}
		})();

		await writer.write({ samples: [input], offset: 0, sampleRate: TEST_SAMPLE_RATE, bitDepth: 32 });
		await writer.close();

		const collected = await drain;

		const totalLength = collected.reduce((sum, channel) => sum + channel.length, 0);

		expect(totalLength).toBe(input.length);

		// Reassemble and verify it actually applied gain (sanity that the
		// stream did its work without any subprocess).
		const output = new Float32Array(totalLength);
		let writeIndex = 0;

		for (const channel of collected) {
			output.set(channel, writeIndex);
			writeIndex += channel.length;
		}

		const measured = measureLufs([output], TEST_SAMPLE_RATE);

		expect(Math.abs(measured - -16)).toBeLessThan(0.1);
	}, TEST_TIMEOUT_MS);
});
