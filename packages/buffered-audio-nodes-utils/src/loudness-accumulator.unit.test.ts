import { describe, expect, it } from "vitest";
import { IntegratedLufsAccumulator, LoudnessAccumulator } from "./loudness";
import type { LoudnessAccumulatorResult } from "./loudness";
import { computeLoudnessRange } from "./loudness-range";

function generateSine(frequency: number, amplitude: number, sampleRate: number, durationSeconds: number): Float32Array {
	const length = Math.floor(sampleRate * durationSeconds);
	const buffer = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		buffer[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
	}

	return buffer;
}

function pushSineLevels(
	accumulator: LoudnessAccumulator,
	levelsDbfs: ReadonlyArray<number>,
	levelDurationSeconds: number,
	sampleRate: number,
	channelCount: number,
	chunkFrames: number,
): number {
	const channels = Array.from({ length: channelCount }, () => new Float32Array(chunkFrames));
	const framesPerLevel = Math.round(levelDurationSeconds * sampleRate);
	let absoluteFrame = 0;

	for (const levelDbfs of levelsDbfs) {
		const amplitude = Math.pow(10, levelDbfs / 20);

		for (let levelOffset = 0; levelOffset < framesPerLevel; levelOffset += chunkFrames) {
			const frames = Math.min(chunkFrames, framesPerLevel - levelOffset);

			for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
				const sample = amplitude * Math.sin(2 * Math.PI * 1000 * absoluteFrame / sampleRate);

				for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
					const channel = channels[channelIndex];

					if (channel) channel[frameIndex] = sample;
				}

				absoluteFrame++;
			}

			accumulator.push(channels, frames);
		}
	}

	return levelsDbfs.length * framesPerLevel;
}

function pushSilence(accumulator: LoudnessAccumulator, frames: number, channelCount: number, chunkFrames: number): void {
	const channels = Array.from({ length: channelCount }, () => new Float32Array(chunkFrames));

	for (let offset = 0; offset < frames; offset += chunkFrames) {
		accumulator.push(channels, Math.min(chunkFrames, frames - offset));
	}
}

function measureSineLevelRange(levelsDbfs: ReadonlyArray<number>, chunkFrames = 8192): LoudnessAccumulatorResult {
	const sampleRate = 48000;
	const accumulator = new LoudnessAccumulator(sampleRate, 2);

	pushSineLevels(accumulator, levelsDbfs, 20, sampleRate, 2, chunkFrames);

	return accumulator.finalize();
}

describe("LoudnessAccumulator", () => {
	it.each([
		{ levels: [-20, -30], expected: 10 },
		{ levels: [-20, -15], expected: 5 },
		{ levels: [-40, -20], expected: 20 },
		{ levels: [-50, -35, -20, -35, -50], expected: 15 },
	])("Tech 3342 minimum-requirements levels $levels yield $expected LU LRA", ({ levels, expected }) => {
		const result = measureSineLevelRange(levels);

		expect(Math.abs(result.range - expected)).toBeLessThanOrEqual(1);
	});

	it("silence yields integrated -Infinity, range 0, and short-term/momentary at the dB floor", () => {
		// 4 s of silence gives ≥1 closed 3 s block: integrated -Infinity (absolute-gate fail), range 0 (<2 survivors), and each closed momentary/shortTerm block carries the LUFS_OFFSET + 10*log10(1e-10) = -100.691 floor.
		const sampleRate = 48000;
		const silence = new Float32Array(sampleRate * 4);

		const accumulator = new LoudnessAccumulator(sampleRate, 1);

		accumulator.push([silence], silence.length);

		const result = accumulator.finalize();

		expect(result.integrated).toBe(-Infinity);
		expect(result.range).toBe(0);
		expect(result.momentary.length).toBeGreaterThan(0);
		expect(result.shortTerm.length).toBeGreaterThan(0);

		for (let i = 0; i < result.momentary.length; i++) {
			expect(result.momentary[i]).toBeCloseTo(-100.691, 3);
		}

		for (let i = 0; i < result.shortTerm.length; i++) {
			expect(result.shortTerm[i]).toBeCloseTo(-100.691, 3);
		}
	});

	it("integrated cross-checks IntegratedLufsAccumulator on a 1 kHz sine within 1e-9 relative", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);

		const reference = new IntegratedLufsAccumulator(sampleRate, 1);

		reference.push([sine], sine.length);

		const referenceIntegrated = reference.finalize();

		const accumulator = new LoudnessAccumulator(sampleRate, 1);

		accumulator.push([sine], sine.length);

		const result = accumulator.finalize();

		// Both consume the same K-weighted squared sums and the same 400 ms / 100 ms gating helper, so integrated must match to float round-off.
		expect(Math.abs(result.integrated - referenceIntegrated) / Math.abs(referenceIntegrated)).toBeLessThan(1e-9);

		// momentary = floor((5*48000 - 0.4*48000)/4800)+1 = 47; short-term = floor((5*48000 - 3*48000)/4800)+1 = 21.
		expect(result.momentary.length).toBe(47);
		expect(result.shortTerm.length).toBe(21);
	});

	it("chunked push parity: same final result for one push vs many small chunks", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);

		const oneShot = new LoudnessAccumulator(sampleRate, 1);

		oneShot.push([sine], sine.length);

		const oneShotResult = oneShot.finalize();

		const chunked = new LoudnessAccumulator(sampleRate, 1);
		const chunkFrames = 7777;

		for (let offset = 0; offset < sine.length; offset += chunkFrames) {
			const frames = Math.min(chunkFrames, sine.length - offset);
			const slice = sine.subarray(offset, offset + frames);

			chunked.push([slice], frames);
		}

		const chunkedResult = chunked.finalize();

		expect(Math.abs(chunkedResult.integrated - oneShotResult.integrated)).toBeLessThan(1e-6);
		expect(chunkedResult.momentary.length).toBe(oneShotResult.momentary.length);
		expect(chunkedResult.shortTerm.length).toBe(oneShotResult.shortTerm.length);

		for (let i = 0; i < oneShotResult.momentary.length; i++) {
			expect(Math.abs((chunkedResult.momentary[i] ?? 0) - (oneShotResult.momentary[i] ?? 0))).toBeLessThan(1e-6);
		}

		for (let i = 0; i < oneShotResult.shortTerm.length; i++) {
			expect(Math.abs((chunkedResult.shortTerm[i] ?? 0) - (oneShotResult.shortTerm[i] ?? 0))).toBeLessThan(1e-6);
		}

		expect(Math.abs(chunkedResult.range - oneShotResult.range)).toBeLessThan(1e-6);
	});

	it("multi-level measurement is invariant to awkward chunk boundaries", () => {
		const sampleRate = 48000;
		const levels = [-18, -32, -12];
		const first = new LoudnessAccumulator(sampleRate, 2);
		const second = new LoudnessAccumulator(sampleRate, 2);

		pushSineLevels(first, levels, 3, sampleRate, 2, 8192);
		pushSineLevels(second, levels, 3, sampleRate, 2, 7777);

		const firstResult = first.finalize();
		const secondResult = second.finalize();

		expect(Math.abs(firstResult.integrated - secondResult.integrated)).toBeLessThan(1e-6);
		expect(Math.abs(firstResult.range - secondResult.range)).toBeLessThan(1e-6);
		expect(firstResult.momentary).toEqual(secondResult.momentary);
		expect(firstResult.shortTerm).toEqual(secondResult.shortTerm);
	});

	it("uses a 1.5-second K-weighted file tail only for range", () => {
		const sampleRate = 48000;
		const channelCount = 1;
		const levels = [-30, -10];
		const source = new LoudnessAccumulator(sampleRate, channelCount);
		const explicitTail = new LoudnessAccumulator(sampleRate, channelCount);
		const sourceFrames = pushSineLevels(source, levels, 4, sampleRate, channelCount, 4096);

		pushSineLevels(explicitTail, levels, 4, sampleRate, channelCount, 4096);
		pushSilence(explicitTail, Math.round(1.5 * sampleRate), channelCount, 4096);

		const sourceResult = source.finalize();
		const explicitTailResult = explicitTail.finalize();
		const blockSize = Math.round(3 * sampleRate);
		const blockStep = Math.round(0.1 * sampleRate);
		const sourceShortTermCount = Math.floor((sourceFrames - blockSize) / blockStep) + 1;

		expect(sourceResult.shortTerm.length).toBe(sourceShortTermCount);
		expect(Math.abs(sourceResult.range - computeLoudnessRange(explicitTailResult.shortTerm))).toBeLessThan(1e-6);
	});

	it("two identical channels are +3.01 dB louder than one (BS.1770 sums channel powers)", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		// Fresh copy because biquad state is per-channel.
		const sineCopy = Float32Array.from(sine);

		const mono = new LoudnessAccumulator(sampleRate, 1);

		mono.push([sine], sine.length);

		const monoIntegrated = mono.finalize().integrated;

		const stereo = new LoudnessAccumulator(sampleRate, 2);

		stereo.push([sine, sineCopy], sine.length);

		const stereoIntegrated = stereo.finalize().integrated;

		const delta = stereoIntegrated - monoIntegrated;

		expect(delta).toBeGreaterThan(3.01 - 0.1);
		expect(delta).toBeLessThan(3.01 + 0.1);
	});

	it("finalize is idempotent: subsequent calls return the same cached result reference", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);

		const accumulator = new LoudnessAccumulator(sampleRate, 1);

		accumulator.push([sine], sine.length);

		const first = accumulator.finalize();
		const second = accumulator.finalize();

		expect(second).toBe(first);
		expect(second.momentary).toBe(first.momentary);
		expect(second.shortTerm).toBe(first.shortTerm);
	});

	it("push after finalize throws", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 1);

		const accumulator = new LoudnessAccumulator(sampleRate, 1);

		accumulator.push([sine], sine.length);
		accumulator.finalize();

		expect(() => {
			accumulator.push([sine], sine.length);
		}).toThrow(/push.*after finalize/);
	});
});
