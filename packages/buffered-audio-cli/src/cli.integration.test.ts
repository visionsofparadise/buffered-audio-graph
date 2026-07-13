import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "dist", "cli.js");
const nodesDir = join(here, "..", "..", "buffered-audio-nodes");
const nodesVersion = "0.21.0";

function writeWav(path: string, samples: ReadonlyArray<number>, sampleRate: number): void {
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
	buffer.writeUInt16LE(bytesPerSample, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);

	for (let i = 0; i < samples.length; i++) {
		buffer.writeInt16LE(samples[i] ?? 0, 44 + i * bytesPerSample);
	}

	writeFileSync(path, buffer);
}

function writeBag(path: string, packageVersion: string, inputPath: string, outputPath: string): void {
	const definition = {
		id: randomUUID(),
		name: "cli-integration",
		apiVersion: 1,
		nodes: [
			{ id: "read", packageName: "@buffered-audio/nodes", packageVersion, nodeName: "Read WAV", parameters: { path: inputPath } },
			{ id: "write", packageName: "@buffered-audio/nodes", packageVersion, nodeName: "Write", parameters: { path: outputPath, bitDepth: "16" } },
		],
		edges: [{ from: "read", to: "write" }],
	};

	writeFileSync(path, JSON.stringify(definition));
}

describe("bag render", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "bag-cli-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("renders a bag when the pinned package is provided via --resolve", () => {
		const inputPath = join(workDir, "input.wav");
		const outputPath = join(workDir, "output.wav");
		const bagPath = join(workDir, "graph.bag");

		writeWav(inputPath, Array.from({ length: 256 }, (_, i) => Math.round(Math.sin(i / 8) * 10000)), 8000);
		writeBag(bagPath, nodesVersion, inputPath, outputPath);

		const result = spawnSync(process.execPath, [cliPath, "render", bagPath, "--resolve", `@buffered-audio/nodes=${nodesDir}`], { encoding: "utf-8" });

		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(outputPath)).toBe(true);
		expect(result.stderr).toContain("overrides pin @buffered-audio/nodes");
	});

	it("exits non-zero naming the package when --no-install meets an unsatisfiable pin", () => {
		const inputPath = join(workDir, "input2.wav");
		const outputPath = join(workDir, "output2.wav");
		const bagPath = join(workDir, "graph2.bag");

		writeWav(inputPath, Array.from({ length: 64 }, () => 0), 8000);
		writeBag(bagPath, "999.0.0", inputPath, outputPath);

		const result = spawnSync(process.execPath, [cliPath, "render", bagPath, "--no-install"], { encoding: "utf-8" });

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("@buffered-audio/nodes");
		expect(existsSync(outputPath)).toBe(false);
	});
});
