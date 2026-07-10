import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resampleDirect } from "./resample-direct";
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

describeIfFfmpeg("ResampleStream", () => {
	it("streaming output matches one-shot resampleDirect within a small tolerance", async () => {
		const sourceRate = 48000;
		const targetRate = 44100;
		const seconds = 0.5;
		const channels = 2;
		const left = makeSine(sourceRate, seconds, 440);
		const right = makeSine(sourceRate, seconds, 660);

		const oneShot = await resampleDirect(ffmpegPath, [left, right], sourceRate, targetRate);

		const stream = new ResampleStream(ffmpegPath, { sourceSampleRate: sourceRate, targetSampleRate: targetRate, channels });
		const writeChunk = 1024;
		const readChunk = 4096;
		const collected: Array<Array<Float32Array>> = [];

		const readerDone = (async () => {
			for (;;) {
				const ready = await stream.read(readChunk);
				const readFrames = ready[0]?.length ?? 0;

				if (readFrames === 0) return;
				collected.push(ready);
			}
		})();

		try {
			for (let offset = 0; offset < left.length; offset += writeChunk) {
				const slice = [
					left.subarray(offset, Math.min(offset + writeChunk, left.length)),
					right.subarray(offset, Math.min(offset + writeChunk, right.length)),
				];

				await stream.write(slice);
			}

			await stream.end();
			await readerDone;
		} finally {
			await stream.close();
		}

		const totalFrames = collected.reduce((acc, c) => acc + (c[0]?.length ?? 0), 0);
		const streamedLeft = new Float32Array(totalFrames);
		const streamedRight = new Float32Array(totalFrames);
		let offset = 0;

		for (const c of collected) {
			const lc = c[0];
			const rc = c[1];
			const n = lc?.length ?? 0;

			if (lc) streamedLeft.set(lc, offset);
			if (rc) streamedRight.set(rc, offset);
			offset += n;
		}

		const oneShotLeft = oneShot[0];
		const oneShotRight = oneShot[1];

		expect(oneShotLeft).toBeDefined();
		expect(oneShotRight).toBeDefined();
		if (!oneShotLeft || !oneShotRight) return;

		// Tolerance allows a tiny length mismatch for filter-tail boundary differences.
		expect(Math.abs(streamedLeft.length - oneShotLeft.length)).toBeLessThanOrEqual(8);

		const cmpLen = Math.min(streamedLeft.length, oneShotLeft.length);
		let maxDiff = 0;

		for (let i = 0; i < cmpLen; i++) {
			const dl = Math.abs((streamedLeft[i] ?? 0) - (oneShotLeft[i] ?? 0));
			const dr = Math.abs((streamedRight[i] ?? 0) - (oneShotRight[i] ?? 0));

			if (dl > maxDiff) maxDiff = dl;
			if (dr > maxDiff) maxDiff = dr;
		}

		// SoXR + triangular dither is deterministic, so one-shot vs streaming differ only by ffmpeg framing (1e-3 tolerance).
		expect(maxDiff).toBeLessThan(1e-3);
	}, 30_000);

	it("handles short input and drains the tail correctly", async () => {
		const sourceRate = 44100;
		const targetRate = 22050;
		const channels = 1;
		const mono = makeSine(sourceRate, 0.1, 220);
		const stream = new ResampleStream(ffmpegPath, { sourceSampleRate: sourceRate, targetSampleRate: targetRate, channels });

		try {
			await stream.write([mono]);
			await stream.end();

			const collected: Array<Float32Array> = [];

			for (;;) {
				const got = await stream.read(4096);
				const ch = got[0];
				const n = ch?.length ?? 0;

				if (n === 0) break;
				if (ch) collected.push(ch);
			}

			const totalFrames = collected.reduce((acc, c) => acc + c.length, 0);
			const expected = Math.floor(mono.length * targetRate / sourceRate);

			expect(Math.abs(totalFrames - expected)).toBeLessThanOrEqual(8);
		} finally {
			await stream.close();
		}
	}, 15_000);
});
