import { describe, it, expect } from "vitest";
import { computeChunkWindow, computeProcessGeometry, computeWriteClip } from "./geometry";

// Default STFT sizing from the node schema.
const FFT = 4096;
const HOP = 1024;

describe("computeProcessGeometry", () => {
	// Happy path: 1 s of 44.1 kHz audio at the default STFT sizing.
	it("computes edge pad, process-frame count, and warmup-frame count", () => {
		const geometry = computeProcessGeometry({ totalFrames: 44100, fftSize: FFT, hopSize: HOP, sampleRate: 44100, warmupSeconds: 30 });

		expect(geometry.edgePadSamples).toBe(3072); // fftSize - hopSize
		expect(geometry.processStftFrames).toBe(47);
		expect(geometry.warmupFrames).toBe(40);
	});

	// Warmup window is clamped to the file length: a 1 s file yields at most 1 s of warmup regardless of the 30 s request.
	it("clamps the warmup window to totalFrames", () => {
		const geometry = computeProcessGeometry({ totalFrames: 44100, fftSize: FFT, hopSize: HOP, sampleRate: 44100, warmupSeconds: 30 });
		const wholeFileWarmup = computeProcessGeometry({ totalFrames: 44100, fftSize: FFT, hopSize: HOP, sampleRate: 44100, warmupSeconds: 1 });

		// 30 s and 1 s requests both saturate at the 1 s file, so warmupFrames matches.
		expect(geometry.warmupFrames).toBe(wholeFileWarmup.warmupFrames);
	});

	// Boundary: a signal shorter than one STFT frame produces zero warmup frames (no negative counts).
	it("returns zero warmup frames for a signal shorter than one frame", () => {
		const geometry = computeProcessGeometry({ totalFrames: 100, fftSize: FFT, hopSize: HOP, sampleRate: 44100, warmupSeconds: 30 });

		expect(geometry.warmupFrames).toBe(0);
		expect(geometry.processStftFrames).toBe(4);
	});

	// Missing sample rate falls back to 48 kHz for the warmup-seconds→samples conversion.
	it("defaults the sample rate to 48000 when undefined", () => {
		const withDefault = computeProcessGeometry({ totalFrames: 10_000_000, fftSize: FFT, hopSize: HOP, sampleRate: undefined, warmupSeconds: 30 });
		const explicit48k = computeProcessGeometry({ totalFrames: 10_000_000, fftSize: FFT, hopSize: HOP, sampleRate: 48000, warmupSeconds: 30 });

		expect(withDefault.warmupFrames).toBe(explicit48k.warmupFrames);
	});
});

describe("computeChunkWindow", () => {
	// Happy path: an interior chunk carries `carry` frames on the leading side once past the head.
	it("clamps window bounds and adds carry frames on each side", () => {
		const window = computeChunkWindow({ outStart: 40, chunkFrames: 20, processStftFrames: 47, carry: 32, fftSize: FFT, hopSize: HOP });

		expect(window.outFramesThisChunk).toBe(7); // min(20, 47 - 40)
		expect(window.winStart).toBe(8); // max(0, 40 - 32)
		expect(window.winEnd).toBe(47); // min(47, 40 + 7 + 32)
		expect(window.winFrames).toBe(39);
		expect(window.winSamples).toBe(39 * HOP + (FFT - HOP));
	});

	// Boundary: the first chunk cannot carry below zero.
	it("clamps winStart to zero at the stream head", () => {
		const window = computeChunkWindow({ outStart: 0, chunkFrames: 20, processStftFrames: 47, carry: 32, fftSize: FFT, hopSize: HOP });

		expect(window.winStart).toBe(0);
		expect(window.winEnd).toBe(47); // min(47, 0 + 20 + 32)
		expect(window.outFramesThisChunk).toBe(20);
	});
});

describe("computeWriteClip", () => {
	// Final chunk: center end is the iSTFT output length; the write clips to totalFrames.
	it("maps the final chunk's center region to real positions and clips to totalFrames", () => {
		const clip = computeWriteClip({
			outStart: 40,
			winStart: 8,
			outFramesThisChunk: 7,
			processStftFrames: 47,
			hopSize: HOP,
			edgePadSamples: 3072,
			totalFrames: 44100,
			cleanedLength: 43008,
		});

		expect(clip).toEqual({ clipStart: 37888, sliceFromOffset: 32768, sliceLength: 6212 });
	});

	// A chunk whose real range lands entirely inside the virtual head pad clips to nothing.
	it("returns undefined when the clipped region is empty", () => {
		const clip = computeWriteClip({
			outStart: 0,
			winStart: 0,
			outFramesThisChunk: 1,
			processStftFrames: 47,
			hopSize: HOP,
			edgePadSamples: 3072,
			totalFrames: 44100,
			cleanedLength: 51200,
		});

		expect(clip).toBeUndefined();
	});
});
