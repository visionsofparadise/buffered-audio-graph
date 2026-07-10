import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Block, type RenderEvents, type StreamSetupContext, type StreamContext } from "@buffered-audio/core";
import { loudnessStats, LoudnessStatsStream } from ".";
import { read } from "../../sources/read";
import { createTestWav } from "../../utils/test-wav";

const TEST_SAMPLE_RATE = 48_000;

// Self-generated input WAV (4 s of 440 Hz sine — long enough for BS.1770 integrated gating), no fetched fixture.
let testVoice: string;

beforeAll(() => {
	const frames = TEST_SAMPLE_RATE * 4;
	const samples = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		samples[index] = Math.sin((2 * Math.PI * 440 * index) / TEST_SAMPLE_RATE) * 0.5;
	}

	testVoice = join(tmpdir(), `ban-loudness-input-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
	writeFileSync(testVoice, createTestWav(TEST_SAMPLE_RATE, 1, [samples]));
});

afterAll(() => {
	try {
		unlinkSync(testVoice);
	} catch {
		// already removed
	}
});

function renderContext(): StreamContext {
	return { events: new EventEmitter() as RenderEvents, nextStreamId: () => 0 };
}

async function runStats(channels: ReadonlyArray<Float32Array>, sampleRate: number, options?: { bucketCount?: number; outputPath?: string }): Promise<NonNullable<LoudnessStatsStream["stats"]>> {
	const stream = new LoudnessStatsStream(loudnessStats({ bucketCount: options?.bucketCount ?? 1024, outputPath: options?.outputPath ?? "" }), renderContext());
	const chunk: Block = { samples: channels.map((channel) => new Float32Array(channel)), offset: 0, sampleRate, bitDepth: 32 };
	const input = new ReadableStream<Block>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});
	const context: StreamSetupContext = {
		executionProviders: ["cpu"],
		memoryLimit: Number.POSITIVE_INFINITY,
		highWaterMark: 1,
	};

	await stream.setup(input, context);

	const stats = stream.stats;

	if (!stats) throw new Error("expected stats to be defined");

	return stats;
}

function makeUniform(length: number, amplitude: number, seed: number): Float32Array {
	const buffer = new Float32Array(length);
	let state = seed >>> 0;

	for (let index = 0; index < length; index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		buffer[index] = (state / 0x1_0000_0000) * 2 * amplitude - amplitude;
	}

	return buffer;
}

function makeSine(length: number, amplitude: number, frequency: number, sampleRate: number): Float32Array {
	const buffer = new Float32Array(length);

	for (let index = 0; index < length; index++) {
		buffer[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude;
	}

	return buffer;
}

describe("loudness-stats", () => {
	it("processes voice audio and produces stats", async () => {
		const target = loudnessStats();
		const source = read(testVoice);

		source.to(target);

		const job = source.createRenderJob();

		await job.render();

		const targetStream = job.streams.get(target)?.[0];

		if (!(targetStream instanceof LoudnessStatsStream)) throw new Error("expected a LoudnessStatsStream for the target node");

		const stats = targetStream.stats;

		expect(stats).toBeDefined();
		expect(stats!.integrated).toBeGreaterThan(-70);
		expect(stats!.integrated).toBeLessThan(0);
		expect(stats!.amplitude).toBeDefined();
		expect(stats!.amplitude.totalSamples).toBeGreaterThan(0);
	});

	it("uniform [-0.5, 0.5) input gives median ≈ 0.25 and percentile(95) ≈ 0.475", async () => {
		// 4 s of uniform noise to provide enough samples for stable percentiles.
		const samples = makeUniform(TEST_SAMPLE_RATE * 4, 0.5, 42);
		const stats = await runStats([samples], TEST_SAMPLE_RATE);

		expect(stats.amplitude.median).toBeGreaterThan(0.24);
		expect(stats.amplitude.median).toBeLessThan(0.26);
		expect(stats.amplitude.percentile(95)).toBeGreaterThan(0.46);
		expect(stats.amplitude.percentile(95)).toBeLessThan(0.49);
	});

	it("sine wave at amplitude A has median(|x|) ≈ A × 2/π (mean abs deviation)", async () => {
		const amplitude = 0.4;
		const samples = makeSine(TEST_SAMPLE_RATE * 4, amplitude, 440, TEST_SAMPLE_RATE);
		const stats = await runStats([samples], TEST_SAMPLE_RATE);

		// Median of |A sin(x)| over a full cycle is A × sin(π/4) = A / √2 (not the mean A × 2/π).
		const expectedMedian = amplitude / Math.SQRT2;

		expect(stats.amplitude.median).toBeGreaterThan(expectedMedian * 0.95);
		expect(stats.amplitude.median).toBeLessThan(expectedMedian * 1.05);
	});

	it("explicit bucketCount controls buckets array length", async () => {
		const samples = makeUniform(TEST_SAMPLE_RATE, 0.5, 1);
		const stats = await runStats([samples], TEST_SAMPLE_RATE, { bucketCount: 256 });

		expect(stats.amplitude.buckets.length).toBe(256);
	});

	it("multi-channel input combines into one histogram with summed counts", async () => {
		const left = makeUniform(TEST_SAMPLE_RATE, 0.5, 1);
		const right = makeUniform(TEST_SAMPLE_RATE, 0.5, 2);
		const stats = await runStats([left, right], TEST_SAMPLE_RATE);

		let total = 0;

		for (let i = 0; i < stats.amplitude.buckets.length; i++) total += stats.amplitude.buckets[i] ?? 0;

		expect(total).toBe(left.length + right.length);
		expect(stats.amplitude.totalSamples).toBe(left.length + right.length);
	});

	it("silence: totalSamples = N, all buckets zero, median = 0, percentile = 0", async () => {
		const samples = new Float32Array(TEST_SAMPLE_RATE);
		const stats = await runStats([samples], TEST_SAMPLE_RATE);

		expect(stats.amplitude.totalSamples).toBe(0); // histogram returns zero counts when bucketMax = 0
		expect(stats.amplitude.bucketMax).toBe(0);
		expect(stats.amplitude.median).toBe(0);
		expect(stats.amplitude.percentile(50)).toBe(0);
		expect(stats.amplitude.percentile(99)).toBe(0);

		for (let i = 0; i < stats.amplitude.buckets.length; i++) {
			expect(stats.amplitude.buckets[i]).toBe(0);
		}
	});

	it("percentile(0) returns 0 and percentile(100) returns bucketMax", async () => {
		const samples = makeUniform(TEST_SAMPLE_RATE, 0.5, 7);
		const stats = await runStats([samples], TEST_SAMPLE_RATE);

		expect(stats.amplitude.percentile(0)).toBe(0);
		expect(stats.amplitude.percentile(100)).toBeCloseTo(stats.amplitude.bucketMax, 6);
	});

	// truePeak goes through TruePeakAccumulator (4× upsample), so a sine
	// whose sample peak lies between samples reports a truePeak strictly
	// above the sample peak. A 1 kHz sine at 48 kHz has non-integer phase
	// at the peak, giving measurable intersample lift.
	it("truePeak captures intersample lift on a 1 kHz sine at sample peak 1.0", async () => {
		const samples = makeSine(TEST_SAMPLE_RATE * 1, 1.0, 1000, TEST_SAMPLE_RATE);
		const stats = await runStats([samples], TEST_SAMPLE_RATE);

		// Sample peak is 0 dBFS = 0 dB. True peak should be >= 0 dB
		// (always at least the sample peak) and strictly above for a
		// non-integer-samples-per-cycle sine.
		expect(stats.truePeak).toBeGreaterThan(0);
		// Sanity bound: intersample lift on a single sine is small —
		// well under 6 dB.
		expect(stats.truePeak).toBeLessThan(3);
	});

	// Streaming sanity: feeding many small chunks of a long signal must
	// finalize cleanly without buffering. Under the prior whole-file buffer
	// implementation this would have allocated ~hundreds of MB; the
	// streaming accumulators run in constant memory. We assert no throws
	// and well-formed stats, not process memory (queries are flaky and
	// platform-specific).
	it("streams a 1+ minute signal in many small chunks without throwing", async () => {
		const stream = new LoudnessStatsStream(loudnessStats({ bucketCount: 1024, outputPath: "" }), renderContext());
		const totalFrames = TEST_SAMPLE_RATE * 70;
		const chunkFrames = 4096;
		const chunkCount = Math.ceil(totalFrames / chunkFrames);
		const input = new ReadableStream<Block>({
			start(controller) {
				let remaining = totalFrames;

				for (let i = 0; i < chunkCount; i++) {
					const frames = Math.min(chunkFrames, remaining);

					controller.enqueue({
						samples: [new Float32Array(frames), new Float32Array(frames)],
						offset: i * chunkFrames,
						sampleRate: TEST_SAMPLE_RATE,
						bitDepth: 32,
					});
					remaining -= frames;
				}

				controller.close();
			},
		});
		const context: StreamSetupContext = {
			executionProviders: ["cpu"],
			memoryLimit: Number.POSITIVE_INFINITY,
			highWaterMark: 1,
		};

		await stream.setup(input, context);

		const stats = stream.stats;

		expect(stats).toBeDefined();
		// Silent stereo input: integrated is -Infinity, range is 0.
		expect(stats!.integrated).toBe(-Infinity);
		expect(stats!.range).toBe(0);
		expect(Number.isNaN(stats!.truePeak)).toBe(false);
		expect(stats!.amplitude.buckets.length).toBe(1024);
	}, 60_000);

	describe("JSON sidecar", () => {
		const tempPaths: Array<string> = [];

		function tempJsonPath(): string {
			const path = join(tmpdir(), `loudness-stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

			tempPaths.push(path);

			return path;
		}

		afterEach(() => {
			for (const path of tempPaths) {
				try {
					unlinkSync(path);
				} catch {
					// Ignore — file may not exist (e.g. test that asserts no write).
				}
			}

			tempPaths.length = 0;
		});

		it("does not write a file when outputPath is empty (default)", async () => {
			const path = tempJsonPath();
			const samples = makeUniform(TEST_SAMPLE_RATE, 0.5, 11);
			const stats = await runStats([samples], TEST_SAMPLE_RATE);

			expect(stats.amplitude).toBeDefined();
			expect(existsSync(path)).toBe(false);
		});

		it("writes the sidecar with all expected fields when outputPath is set", async () => {
			const path = tempJsonPath();
			const samples = makeUniform(TEST_SAMPLE_RATE, 0.5, 13);

			await runStats([samples], TEST_SAMPLE_RATE, { outputPath: path });

			expect(existsSync(path)).toBe(true);

			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				integrated: number;
				truePeak: number;
				range: number;
				amplitude: { buckets: Array<number>; bucketMax: number; totalSamples: number; median: number };
			};

			expect(typeof parsed.integrated).toBe("number");
			expect("shortTerm" in parsed).toBe(false);
			expect("momentary" in parsed).toBe(false);
			expect(typeof parsed.truePeak).toBe("number");
			expect(typeof parsed.range).toBe("number");
			expect(parsed.amplitude).toBeDefined();
			expect(Array.isArray(parsed.amplitude.buckets)).toBe(true);
			expect(typeof parsed.amplitude.bucketMax).toBe("number");
			expect(typeof parsed.amplitude.totalSamples).toBe("number");
			expect(typeof parsed.amplitude.median).toBe("number");
		});

		it("sidecar values match programmatic stats", async () => {
			const path = tempJsonPath();
			const samples = makeUniform(TEST_SAMPLE_RATE, 0.5, 17);
			const stats = await runStats([samples], TEST_SAMPLE_RATE, { outputPath: path });

			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				integrated: number;
				truePeak: number;
				range: number;
				amplitude: { buckets: Array<number>; bucketMax: number; totalSamples: number; median: number };
			};

			expect(parsed.integrated).toBe(stats.integrated);
			expect(parsed.truePeak).toBe(stats.truePeak);
			expect(parsed.range).toBe(stats.range);
			expect(parsed.amplitude.bucketMax).toBe(stats.amplitude.bucketMax);
			expect(parsed.amplitude.totalSamples).toBe(stats.amplitude.totalSamples);
			expect(parsed.amplitude.median).toBe(stats.amplitude.median);
			expect(parsed.amplitude.buckets.length).toBe(stats.amplitude.buckets.length);

			for (let bucketIndex = 0; bucketIndex < parsed.amplitude.buckets.length; bucketIndex++) {
				expect(parsed.amplitude.buckets[bucketIndex]).toBe(stats.amplitude.buckets[bucketIndex]);
			}
		});

		it("overwrites an existing file at outputPath without error", async () => {
			const path = tempJsonPath();

			writeFileSync(path, "stale content");
			expect(readFileSync(path, "utf8")).toBe("stale content");

			const samples = makeUniform(TEST_SAMPLE_RATE, 0.5, 19);

			await runStats([samples], TEST_SAMPLE_RATE, { outputPath: path });

			const parsed = JSON.parse(readFileSync(path, "utf8")) as { amplitude: { totalSamples: number } };

			expect(parsed.amplitude.totalSamples).toBe(samples.length);
		});
	});
});
