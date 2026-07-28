/* eslint-disable @typescript-eslint/no-non-null-assertion -- typed-array access in test assertions */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyNlmSmoothing, type NlmParams } from "@buffered-audio/utils";
import { createNlmWorkerPool } from "./nlm-worker-pool";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let buildParent = "";
let buildDir: string;
let workerUrl: URL;

beforeAll(() => {
	buildParent = join(packageRoot, "node_modules", ".nlm-worker-test");

	mkdirSync(buildParent, { recursive: true });

	buildDir = mkdtempSync(join(buildParent, "build-"));

	const tsupCli = createRequire(import.meta.url).resolve("tsup/dist/cli-default.js");
	const build = spawnSync(process.execPath, [tsupCli, "--out-dir", buildDir], {
		cwd: packageRoot,
		encoding: "utf-8",
	});

	if (build.status !== 0) {
		throw new Error(
			`Building the NLM worker under test failed (exit ${String(build.status)}): ${build.error?.message ?? ""}\n${build.stderr}`,
		);
	}

	const workerPath = join(buildDir, "nlm-worker.js");

	if (!existsSync(workerPath)) {
		throw new Error(`Building the NLM worker under test produced no ${workerPath}`);
	}

	workerUrl = pathToFileURL(workerPath);
}, 180_000);

afterAll(() => {
	if (buildParent) rmSync(buildParent, { recursive: true, force: true });
});

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;

	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("nlm worker pool parity", () => {
	it("produces byte-identical output to the in-thread kernel in real worker mode (4 threads)", async () => {
		const numFrames = 200;
		const numBins = 129;
		const length = numFrames * numBins;

		const options: NlmParams = {
			patchSize: 8,
			searchFreqRadius: 8,
			searchTimePre: 16,
			searchTimePost: 4,
			pasteBlockSize: 8,
			threshold: 0.75,
		};

		const random = mulberry32(0x1234abcd);
		const maskData = new Float32Array(length);

		for (let i = 0; i < length; i++) maskData[i] = random();

		const expected = new Float32Array(length);

		applyNlmSmoothing(maskData, numFrames, numBins, options, expected);

		const mask = new Float32Array(new SharedArrayBuffer(length * 4));

		mask.set(maskData);

		const output = new Float32Array(new SharedArrayBuffer(length * 4));

		const pool = createNlmWorkerPool(4, workerUrl);

		expect(pool.mode).toBe("worker");

		try {
			await pool.run(mask, output, numFrames, numBins, options);
		} finally {
			await pool.close();
		}

		let maxDiff = 0;

		for (let i = 0; i < length; i++) {
			const diff = Math.abs(expected[i]! - output[i]!);

			if (diff > maxDiff) maxDiff = diff;
		}

		expect(maxDiff).toBe(0);
	});
});
