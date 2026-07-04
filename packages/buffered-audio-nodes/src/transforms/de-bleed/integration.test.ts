/* eslint-disable @typescript-eslint/no-non-null-assertion -- typed-array indexing in test scaffolding */
/**
 * Integration tests for `deBleed`: end-to-end on a synthetic fixture (finite, no DC offset, no clipping); MSAD per-channel activity flags on a 5-mic config; compute-cost scaling across refCount. Manual A/B is intentionally not covered here.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTransform } from "../../utils/test-pipeline";
import { audio } from "../../utils/test-binaries";
import { deBleed } from ".";
import { computeMsadDecision, createMsadChannelState } from "./utils/mef-msad";

// ----- Helpers --------------------------------------------------------------

// Minimal WAV (32-bit float PCM, mono) writer matching the test pipeline's read path; cribbed from deep-filter-net-3/integration.test.ts.
function encodeWavFloat32(samples: Float32Array, sampleRate: number): Buffer {
	const numChannels = 1;
	const bitsPerSample = 32;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataSize = samples.length * (bitsPerSample / 8);
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(3, 20); // IEEE float
	buffer.writeUInt16LE(numChannels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(byteRate, 28);
	buffer.writeUInt16LE(blockAlign, 32);
	buffer.writeUInt16LE(bitsPerSample, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);

	for (let index = 0; index < samples.length; index++) {
		buffer.writeFloatLE(samples[index] ?? 0, 44 + index * 4);
	}

	return buffer;
}

function rms(signal: Float32Array): number {
	let sum = 0;

	for (let index = 0; index < signal.length; index++) {
		const sample = signal[index] ?? 0;

		sum += sample * sample;
	}

	return Math.sqrt(sum / Math.max(signal.length, 1));
}

function meanAbs(signal: Float32Array): number {
	let sum = 0;

	for (let index = 0; index < signal.length; index++) {
		sum += Math.abs(signal[index] ?? 0);
	}

	return sum / Math.max(signal.length, 1);
}

function maxAbs(signal: Float32Array): number {
	let max = 0;

	for (let index = 0; index < signal.length; index++) {
		const value = Math.abs(signal[index] ?? 0);

		if (value > max) max = value;
	}

	return max;
}

function isFloat32Denormal(value: number): boolean {
	const abs = Math.abs(value);

	// Float32 minimum-normal magnitude; anything below this (excluding zero) is denormal.
	return abs > 0 && abs < 1.175494e-38;
}

interface FrameQualityReport {
	readonly finite: boolean;
	readonly nonNan: boolean;
	readonly noDenormals: boolean;
	readonly meanAbs: number;
	readonly maxAbs: number;
	readonly clippedSamples: number;
}

function inspectQuality(signal: Float32Array): FrameQualityReport {
	let finite = true;
	let nonNan = true;
	let noDenormals = true;
	let clippedSamples = 0;

	for (let index = 0; index < signal.length; index++) {
		const value = signal[index] ?? 0;

		if (Number.isNaN(value)) nonNan = false;
		if (!Number.isFinite(value)) finite = false;
		if (isFloat32Denormal(value)) noDenormals = false;
		if (Math.abs(value) >= 1) clippedSamples += 1;
	}

	return {
		finite,
		nonNan,
		noDenormals,
		meanAbs: meanAbs(signal),
		maxAbs: maxAbs(signal),
		clippedSamples,
	};
}

function frameMaxAbs(signal: Float32Array, frameSize: number): Array<number> {
	const out: Array<number> = [];

	for (let start = 0; start < signal.length; start += frameSize) {
		const end = Math.min(start + frameSize, signal.length);
		let frameMax = 0;

		for (let index = start; index < end; index++) {
			const value = Math.abs(signal[index] ?? 0);

			if (value > frameMax) frameMax = value;
		}

		out.push(frameMax);
	}

	return out;
}

function spectralCentroidHz(signal: Float32Array, sampleRate: number): number {
	const windowSize = Math.min(8192, signal.length);

	if (windowSize < 64) return 0;

	const start = Math.floor((signal.length - windowSize) / 2);
	const window = new Float32Array(windowSize);

	for (let n = 0; n < windowSize; n++) {
		const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (windowSize - 1)));

		window[n] = (signal[start + n] ?? 0) * w;
	}

	const numBins = windowSize / 2;
	let weightedSum = 0;
	let magnitudeSum = 0;

	for (let k = 0; k < numBins; k++) {
		let real = 0;
		let imag = 0;

		for (let n = 0; n < windowSize; n++) {
			const angle = (-2 * Math.PI * k * n) / windowSize;

			real += (window[n] ?? 0) * Math.cos(angle);
			imag += (window[n] ?? 0) * Math.sin(angle);
		}

		const magnitude = Math.sqrt(real * real + imag * imag);
		const frequency = (k * sampleRate) / windowSize;

		weightedSum += frequency * magnitude;
		magnitudeSum += magnitude;
	}

	return magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;
}

interface SyntheticMixOptions {
	readonly sampleRate: number;
	readonly durationSeconds: number;
	readonly targetFrequencyHz: number;
	readonly bleedSpec: ReadonlyArray<{ frequencyHz: number; bleedScale: number; bleedDelaySamples: number }>;
}

interface SyntheticMix {
	readonly target: Float32Array;
	readonly references: Array<Float32Array>;
}

function synthesiseMix(options: SyntheticMixOptions): SyntheticMix {
	const { sampleRate, durationSeconds, targetFrequencyHz, bleedSpec } = options;
	const numSamples = Math.floor(sampleRate * durationSeconds);
	const target = new Float32Array(numSamples);
	const references = bleedSpec.map(() => new Float32Array(numSamples));

	for (let n = 0; n < numSamples; n++) {
		target[n] = 0.3 * Math.sin((2 * Math.PI * targetFrequencyHz * n) / sampleRate);
	}

	for (let r = 0; r < bleedSpec.length; r++) {
		const spec = bleedSpec[r]!;
		const refSignal = references[r]!;

		for (let n = 0; n < numSamples; n++) {
			refSignal[n] = 0.5 * Math.sin((2 * Math.PI * spec.frequencyHz * n) / sampleRate);
		}

		const delay = Math.max(0, spec.bleedDelaySamples);

		for (let n = delay; n < numSamples; n++) {
			target[n] = (target[n] ?? 0) + spec.bleedScale * (refSignal[n - delay] ?? 0);
		}
	}

	return { target, references };
}

interface WrittenFixtures {
	readonly targetPath: string;
	readonly referencePaths: Array<string>;
	cleanup: () => Promise<void>;
}

async function writeFixtures(mix: SyntheticMix, sampleRate: number): Promise<WrittenFixtures> {
	const tag = randomBytes(8).toString("hex");
	const targetPath = join(tmpdir(), `dba-target-${tag}.wav`);
	const referencePaths = mix.references.map((_, refIndex) => join(tmpdir(), `dba-ref${refIndex}-${tag}.wav`));

	await writeFile(targetPath, encodeWavFloat32(mix.target, sampleRate));

	for (let r = 0; r < mix.references.length; r++) {
		await writeFile(referencePaths[r]!, encodeWavFloat32(mix.references[r]!, sampleRate));
	}

	return {
		targetPath,
		referencePaths,
		cleanup: async () => {
			await unlink(targetPath).catch(() => undefined);

			for (const path of referencePaths) {
				await unlink(path).catch(() => undefined);
			}
		},
	};
}

// ----- Phase 4.1 ------------------------------------------------------------

describe("deBleed integration", () => {
	// 44.1 kHz mirrors testVoice; warmupSeconds=30 covers the first half; single reference scaled 0.4, delay 11.
	it.sequential("processes a 60-s synthetic fixture without NaN, denormals, DC offset, or clipping", async () => {
		const sampleRate = 44100;
		const durationSeconds = 60;
		const mix = synthesiseMix({
			sampleRate,
			durationSeconds,
			targetFrequencyHz: 220,
			bleedSpec: [{ frequencyHz: 660, bleedScale: 0.4, bleedDelaySamples: 11 }],
		});
		const fixtures = await writeFixtures(mix, sampleRate);

		try {
			const transform = deBleed(fixtures.referencePaths);
			const { output } = await runTransform(fixtures.targetPath, transform);

			const channel = output[0]!;
			const report = inspectQuality(channel);

			expect(report.finite).toBe(true);
			expect(report.nonNan).toBe(true);
			expect(report.noDenormals).toBe(true);
			// DC offset = |signed mean|; 1e-3 is the threshold for float32 audio.
			let signedSum = 0;
			for (let index = 0; index < channel.length; index++) signedSum += channel[index] ?? 0;
			const dcOffset = Math.abs(signedSum / channel.length);
			expect(dcOffset).toBeLessThan(1e-3);
			expect(report.clippedSamples).toBe(0);
			expect(channel.length).toBeGreaterThan(0);
		} finally {
			await fixtures.cleanup();
		}
	}, 1_800_000);

});

// ----- Phase 4.2 ------------------------------------------------------------

describe("deBleed multi-reference scaling (Phase 4.2)", () => {
	// Probes `computeMsadDecision` directly because the per-stream MSAD state inside `_process` is internal and not surfaced.
	it("MSAD reports each speaker active during its own speech and inactive during silence (5-mic config)", () => {
		const numBins = 64;
		const channelCount = 5; // [target, ref0, ref1, ref2, ref3]
		const states = Array.from({ length: channelCount }, () => createMsadChannelState(numBins));

		const reals = Array.from({ length: channelCount }, () => new Float32Array(numBins));
		const imags = Array.from({ length: channelCount }, () => new Float32Array(numBins));

		let pseudoSeed = 0xfeed1234;
		const pseudoRandom = (): number => {
			pseudoSeed = (pseudoSeed * 1664525 + 1013904223) >>> 0;

			return pseudoSeed / 0xffffffff - 0.5;
		};

		const noiseLevel = 0.001;

		for (let frame = 0; frame < 100; frame++) {
			for (let m = 0; m < channelCount; m++) {
				for (let bin = 0; bin < numBins; bin++) {
					reals[m]![bin] = noiseLevel * pseudoRandom();
					imags[m]![bin] = noiseLevel * pseudoRandom();
				}
			}

			computeMsadDecision(reals, imags, states);
		}

		for (let activeChannel = 0; activeChannel < channelCount; activeChannel++) {
			let lastDecision = computeMsadDecision(reals, imags, states);

			for (let frame = 0; frame < 30; frame++) {
				for (let m = 0; m < channelCount; m++) {
					const isActive = m === activeChannel;
					const level = isActive ? 1.0 : noiseLevel;

					for (let bin = 0; bin < numBins; bin++) {
						reals[m]![bin] = level * pseudoRandom();
						imags[m]![bin] = level * pseudoRandom();
					}
				}

				lastDecision = computeMsadDecision(reals, imags, states);
			}

			if (activeChannel === 0) {
				expect(lastDecision.targetActive).toBe(true);
			} else {
				expect(lastDecision.targetActive).toBe(false);
				expect(lastDecision.referenceActive[activeChannel - 1]!).toBe(true);
			}

			for (let m = 0; m < channelCount; m++) {
				if (m === activeChannel) continue;

				if (m === 0) {
					expect(lastDecision.targetActive).toBe(false);
				} else {
					expect(lastDecision.referenceActive[m - 1]!).toBe(false);
				}
			}

			for (let frame = 0; frame < 20; frame++) {
				for (let m = 0; m < channelCount; m++) {
					for (let bin = 0; bin < numBins; bin++) {
						reals[m]![bin] = noiseLevel * pseudoRandom();
						imags[m]![bin] = noiseLevel * pseudoRandom();
					}
				}

				computeMsadDecision(reals, imags, states);
			}
		}
	});

	// Invariant: wall-clock(refCount=4) < 3 × wall-clock(refCount=2) (50% slack on linear). 8-s fixture keeps warmup (30-s cap) unaffected; sequential to avoid contention skewing timings.
	it.sequential("compute cost scales roughly linearly with reference count", async () => {
		const sampleRate = 44100;
		const durationSeconds = 8;
		const mix = synthesiseMix({
			sampleRate,
			durationSeconds,
			targetFrequencyHz: 220,
			bleedSpec: [
				{ frequencyHz: 330, bleedScale: 0.3, bleedDelaySamples: 7 },
				{ frequencyHz: 440, bleedScale: 0.2, bleedDelaySamples: 13 },
				{ frequencyHz: 550, bleedScale: 0.15, bleedDelaySamples: 19 },
				{ frequencyHz: 660, bleedScale: 0.1, bleedDelaySamples: 23 },
			],
		});
		const fixtures = await writeFixtures(mix, sampleRate);

		const wallTimes: Record<number, number> = {};

		try {
			for (const refCount of [2, 3, 4]) {
				const refs = fixtures.referencePaths.slice(0, refCount);
				const start = performance.now();
				const transform = deBleed(refs);
				const { output } = await runTransform(fixtures.targetPath, transform);
				const elapsed = performance.now() - start;

				wallTimes[refCount] = elapsed;

				const report = inspectQuality(output[0]!);

				expect(report.finite).toBe(true);
				expect(report.nonNan).toBe(true);
			}

			const t2 = wallTimes[2]!;
			const t3 = wallTimes[3]!;
			const t4 = wallTimes[4]!;

			console.warn(
				`[Phase 4.2 profile] refCount=2 → ${t2.toFixed(0)} ms, refCount=3 → ${t3.toFixed(0)} ms, refCount=4 → ${t4.toFixed(0)} ms ` +
					`(t4/t2 = ${(t4 / t2).toFixed(2)}, target < 3.0)`,
			);

			expect(t4).toBeLessThan(3 * t2);
		} finally {
			await fixtures.cleanup();
		}
	}, 1_800_000);
});
