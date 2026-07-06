import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { NodeIdentity, StreamEvent, StreamPhase } from "@buffered-audio/core";
import { runTransform } from "../../utils/test-pipeline";
import { notSilent, expectedDuration, notAnomalous } from "../../utils/test-audio";
import { audio, binaries, hasBinaryFixtures } from "../../utils/test-binaries";
import { readToBuffer } from "../../utils/read-to-buffer";
import { read } from "../../sources/read";
import { write } from "../../targets/write";
import { chain } from "../../composites/chain";
import { ffmpeg } from ".";

const testVoice = audio.testVoice;
const describeIfFfmpegFixture = hasBinaryFixtures("ffmpeg") ? describe : describe.skip;

describeIfFfmpegFixture("FFmpeg", () => {
	it("processes voice audio", async () => {
		const transform = ffmpeg({ ffmpegPath: binaries.ffmpeg, args: ["-af", "anull"] });
		const { output, context } = await runTransform(testVoice, transform);

		expect(notSilent(output).pass).toBe(true);
		expect(expectedDuration(output, context.durationFrames ?? 0).pass).toBe(true);
		expect(notAnomalous(output).pass).toBe(true);
	}, 240_000);

	it("passes audio through unchanged with anull", async () => {
		const transform = ffmpeg({ ffmpegPath: binaries.ffmpeg, args: ["-af", "anull"] });
		const { input, output } = await runTransform(testVoice, transform);

		expect(output.length).toBe(input.length);

		for (let ch = 0; ch < input.length; ch++) {
			const inputChannel = input[ch];
			const outputChannel = output[ch];

			if (!inputChannel || !outputChannel) throw new Error(`Channel ${ch} missing`);

			expect(outputChannel.length).toBe(inputChannel.length);

			let maxAbsDiff = 0;

			for (let i = 0; i < inputChannel.length; i++) {
				const diff = Math.abs((outputChannel[i] ?? 0) - (inputChannel[i] ?? 0));

				if (diff > maxAbsDiff) maxAbsDiff = diff;
			}

			// `anull` is a documented no-op filter on f32le passthrough; samples must be exact (<1e-7 for float promotion).
			expect(maxAbsDiff).toBeLessThanOrEqual(1e-7);
		}
	}, 240_000);

	it("emits quantum-bounded progress events per phase, not one per chunk", async () => {
		const { context } = await readToBuffer(testVoice);
		const inputFrames = context.durationFrames ?? 0;

		const tempPath = join(tmpdir(), `ban-test-${randomBytes(8).toString("hex")}.wav`);

		const source = read(testVoice);
		const transform = ffmpeg({ ffmpegPath: binaries.ffmpeg, args: ["-af", "anull"] });

		source.to(transform);
		transform.to(write(tempPath, { bitDepth: "32f" }));

		const progressByPhase = new Map<StreamPhase, number>();
		const finishedFramesDone: Array<number> = [];

		const onEvent = (node: NodeIdentity, event: StreamEvent): void => {
			if (node.nodeName !== "FFmpeg") return;

			if (event.kind === "progress") {
				progressByPhase.set(event.phase, (progressByPhase.get(event.phase) ?? 0) + 1);
			} else if (event.kind === "finished") {
				finishedFramesDone.push(event.framesDone);
			}
		};

		try {
			await source.render({ onEvent, chunkSize: 4096 });
		} finally {
			try {
				await unlink(tempPath);
			} catch {
				// Temp file may not exist if the pipeline failed before write.
			}
		}

		const bufferCount = progressByPhase.get("buffer") ?? 0;
		const emitCount = progressByPhase.get("emit") ?? 0;

		// Hundreds of stdin writes over the fixture; the quantum schedule caps each phase far below that.
		const sourceChunks = Math.ceil(inputFrames / 4096);

		expect(sourceChunks).toBeGreaterThan(20);

		// `buffer` has a known total → default quantum 0.1 gives ≤~11 crossings + the forced final.
		expect(bufferCount).toBeGreaterThan(0);
		expect(bufferCount).toBeLessThanOrEqual(13);

		// `emit` is unknown-total → UNKNOWN_TOTAL_QUANTUM_FRAMES (480k) boundaries + the forced final.
		expect(emitCount).toBeGreaterThan(0);
		expect(emitCount).toBeLessThanOrEqual(Math.ceil(inputFrames / 480_000) + 2);

		// Both phases are bounded well under the per-chunk count.
		expect(bufferCount).toBeLessThan(sourceChunks);
		expect(emitCount).toBeLessThan(sourceChunks);

		// `finished` carries the authoritative input frame count.
		expect(finishedFramesDone).toHaveLength(1);
		expect(finishedFramesDone[0]).toBe(inputFrames);
	}, 240_000);

	it("resample roundtrip preserves length within ±2 frames", async () => {
		const { context: inputContext } = await readToBuffer(testVoice);
		const origRate = inputContext.sampleRate;
		const inputFrames = inputContext.durationFrames ?? 0;
		const tempPath = join(tmpdir(), `ban-test-${randomBytes(8).toString("hex")}.wav`);

		try {
			const pipeline = chain(
				read(testVoice),
				ffmpeg({ ffmpegPath: binaries.ffmpeg, args: ["-af", "aresample=24000"], outputSampleRate: 24000 }),
				ffmpeg({ ffmpegPath: binaries.ffmpeg, args: ["-af", `aresample=${origRate}`], outputSampleRate: origRate }),
				write(tempPath, { bitDepth: "32f" }),
			);

			await pipeline.render();

			const { context: outputContext } = await readToBuffer(tempPath);
			const outputFrames = outputContext.durationFrames ?? 0;

			// Resampling rounds at each stage; allow ±2 frames slack.
			expect(Math.abs(outputFrames - inputFrames)).toBeLessThanOrEqual(2);
		} finally {
			try {
				await unlink(tempPath);
			} catch {
				// Temp file may not exist if pipeline failed before write.
			}
		}
	}, 240_000);
});
