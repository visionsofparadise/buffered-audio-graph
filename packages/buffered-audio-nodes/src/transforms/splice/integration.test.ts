import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WaveFile } from "wavefile";
import type { Block } from "@buffered-audio/core";
import { channelSamples, runTransformStream } from "@buffered-audio/core/testing";
import { splice } from ".";

const SAMPLE_RATE = 44100;
const INSERT_FRAMES = 100;
const INSERT_VALUE = 0.5;

let dir: string;
let insertPath: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ban-splice-"));
	insertPath = join(dir, "insert.wav");

	const wav = new WaveFile();

	wav.fromScratch(1, SAMPLE_RATE, "32f", [new Float32Array(INSERT_FRAMES).fill(INSERT_VALUE)]);
	await writeFile(insertPath, Buffer.from(wav.toBuffer()));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeInput(frames: number, value: number): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset: 0, sampleRate: SAMPLE_RATE, bitDepth: 32 };
}

describe("splice", () => {
	it("replaces the insert region and leaves surrounding audio untouched", async () => {
		const insertAt = 200;
		const { blocks } = await runTransformStream(splice(insertPath, insertAt), [makeInput(500, 0.1)]);
		const out = channelSamples(blocks, 0);

		expect(out.length).toBe(500);
		expect(out[insertAt - 1]).toBeCloseTo(0.1, 5);
		expect(out[insertAt]).toBeCloseTo(INSERT_VALUE, 5);
		expect(out[insertAt + INSERT_FRAMES - 1]).toBeCloseTo(INSERT_VALUE, 5);
		expect(out[insertAt + INSERT_FRAMES]).toBeCloseTo(0.1, 5);
	});

	it("replaces the region even when the input is split across chunks", async () => {
		const insertAt = 200;
		const chunks: Array<Block> = [
			{ samples: [new Float32Array(150).fill(0.1)], offset: 0, sampleRate: SAMPLE_RATE, bitDepth: 32 },
			{ samples: [new Float32Array(350).fill(0.1)], offset: 150, sampleRate: SAMPLE_RATE, bitDepth: 32 },
		];
		const out = channelSamples((await runTransformStream(splice(insertPath, insertAt), chunks)).blocks, 0);

		expect(out.length).toBe(500);
		expect(out[insertAt + 50]).toBeCloseTo(INSERT_VALUE, 5);
		expect(out[insertAt - 1]).toBeCloseTo(0.1, 5);
	});
});
