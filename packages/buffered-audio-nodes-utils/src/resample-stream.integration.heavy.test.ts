import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ResampleStream } from "./resample-stream";
import { fixtures } from "./test-fixtures";

const ffmpegPath = fixtures.ffmpeg;
const ffmpegAvailable = existsSync(ffmpegPath);
const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

function makeSine(sampleRate: number, durationSeconds: number, frequency: number, amplitude = 0.5): Float32Array {
	const frames = Math.floor(sampleRate * durationSeconds);
	const out = new Float32Array(frames);
	const omega = 2 * Math.PI * frequency / sampleRate;

	for (let i = 0; i < frames; i++) out[i] = Math.sin(omega * i) * amplitude;

	return out;
}

async function runResample(
	input: ReadonlyArray<Float32Array>,
	sourceSampleRate: number,
	targetSampleRate: number,
	writeFrames: number,
): Promise<Array<Float32Array>> {
	const stream = new ResampleStream(ffmpegPath, {
		sourceSampleRate,
		targetSampleRate,
		channels: input.length,
	});
	const chunks: Array<Array<Float32Array>> = [];
	const readerDone = (async () => {
		for (;;) {
			const chunk = await stream.read(4096);

			if ((chunk[0]?.length ?? 0) === 0) return;
			chunks.push(chunk);
		}
	})();

	try {
		const frames = input[0]?.length ?? 0;

		for (let offset = 0; offset < frames; offset += writeFrames) {
			await stream.write(input.map((channel) => channel.subarray(offset, Math.min(offset + writeFrames, frames))));
		}

		await stream.end();
		await readerDone;
	} finally {
		await stream.close();
	}

	const totalFrames = chunks.reduce((total, chunk) => total + (chunk[0]?.length ?? 0), 0);
	const output = Array.from({ length: input.length }, () => new Float32Array(totalFrames));
	let offset = 0;

	for (const chunk of chunks) {
		const frames = chunk[0]?.length ?? 0;

		for (let channel = 0; channel < output.length; channel++) {
			const destination = output[channel];
			const source = chunk[channel];

			if (destination && source) destination.set(source, offset);
		}

		offset += frames;
	}

	return output;
}

function rootMeanSquare(samples: Float32Array, start: number, end: number): number {
	let sum = 0;

	for (let index = start; index < end; index++) {
		const sample = samples[index] ?? 0;

		sum += sample * sample;
	}

	return Math.sqrt(sum / (end - start));
}

function positiveCrossingFrequency(samples: Float32Array, start: number, end: number, sampleRate: number): number {
	let firstCrossing = -1;
	let lastCrossing = -1;
	let crossings = 0;

	for (let index = start + 1; index < end; index++) {
		if ((samples[index - 1] ?? 0) <= 0 && (samples[index] ?? 0) > 0) {
			firstCrossing = firstCrossing < 0 ? index : firstCrossing;
			lastCrossing = index;
			crossings++;
		}
	}

	if (crossings < 2) return 0;

	return (crossings - 1) * sampleRate / (lastCrossing - firstCrossing);
}

describeIfFfmpeg("ResampleStream", () => {
	it("is chunk-invariant and preserves known stereo sine levels and frequencies", async () => {
		const sourceRate = 48000;
		const targetRate = 44100;
		const seconds = 1;
		const left = makeSine(sourceRate, seconds, 440);
		const right = makeSine(sourceRate, seconds, 660);
		const singleWrite = await runResample([left, right], sourceRate, targetRate, left.length);
		const chunkedWrite = await runResample([left, right], sourceRate, targetRate, 1024);
		const expectedFrames = Math.round(left.length * targetRate / sourceRate);

		for (const output of [...singleWrite, ...chunkedWrite]) {
			expect(Math.abs(output.length - expectedFrames)).toBeLessThanOrEqual(8);
		}

		expect(Math.abs((singleWrite[0]?.length ?? 0) - (chunkedWrite[0]?.length ?? 0))).toBeLessThanOrEqual(8);

		const commonFrames = Math.min(singleWrite[0]?.length ?? 0, chunkedWrite[0]?.length ?? 0);
		let maxDiff = 0;

		for (let channel = 0; channel < singleWrite.length; channel++) {
			for (let index = 0; index < commonFrames; index++) {
				const difference = Math.abs((singleWrite[channel]?.[index] ?? 0) - (chunkedWrite[channel]?.[index] ?? 0));

				if (difference > maxDiff) maxDiff = difference;
			}
		}

		expect(maxDiff).toBeLessThan(1e-3);

		const trim = 512;
		const expectedRms = 0.5 / Math.SQRT2;
		const expectedFrequencies = [440, 660];

		for (const resampled of [singleWrite, chunkedWrite]) {
			for (let channel = 0; channel < resampled.length; channel++) {
				const output = resampled[channel];
				const expectedFrequency = expectedFrequencies[channel];

				expect(output).toBeDefined();
				expect(expectedFrequency).toBeDefined();
				if (!output || expectedFrequency === undefined) continue;

				const end = output.length - trim;

				expect(Math.abs(rootMeanSquare(output, trim, end) - expectedRms)).toBeLessThan(0.01);
				expect(Math.abs(positiveCrossingFrequency(output, trim, end, targetRate) - expectedFrequency)).toBeLessThan(2);
			}
		}
	}, 30_000);

	it("handles short input and drains the tail correctly", async () => {
		const sourceRate = 44100;
		const targetRate = 22050;
		const mono = makeSine(sourceRate, 0.1, 220);
		const [output] = await runResample([mono], sourceRate, targetRate, mono.length);
		const expected = Math.round(mono.length * targetRate / sourceRate);

		expect(output).toBeDefined();
		expect(Math.abs((output?.length ?? 0) - expected)).toBeLessThanOrEqual(8);
	}, 15_000);
});
