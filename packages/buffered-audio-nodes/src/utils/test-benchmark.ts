import { randomBytes } from "node:crypto";
import { appendFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { RenderOptions, SourceNode, TransformNode } from "@buffered-audio/core";
import { read } from "../sources/read";
import { write } from "../targets/write";

export interface BenchmarkResult {
	readonly name: string;
	readonly totalMs: number;
	readonly samplesPerSecond: number;
	readonly realTimeMultiplier: number;
}

export async function runBenchmark(name: string, transform: TransformNode, inputPath: string, renderOptions?: RenderOptions): Promise<BenchmarkResult> {
	const tempPath = resolve(tmpdir(), `ban-bench-${randomBytes(8).toString("hex")}.wav`);

	try {
		const source = read(inputPath);
		const target = write(tempPath, { bitDepth: "32f" });

		source.to(transform);
		transform.to(target);

		await source.render(renderOptions);

		const renderTiming = (source as SourceNode).renderTiming;

		return {
			name,
			totalMs: renderTiming?.totalMs ?? 0,
			samplesPerSecond: 0,
			realTimeMultiplier: renderTiming?.realTimeMultiplier ?? 0,
		};
	} finally {
		try {
			await unlink(tempPath);
		} catch {
			// Temp file may not exist
		}
	}
}

export async function appendBenchmarkLog(logDir: string, result: BenchmarkResult): Promise<void> {
	const logPath = resolve(logDir, "benchmarks.log");
	const timestamp = new Date().toISOString();

	const line = `${timestamp} | ${result.name.padEnd(30)} | ${result.totalMs.toFixed(1).padStart(10)}ms | ${Math.round(result.samplesPerSecond).toString().padStart(14)} samples/sec | ${result.realTimeMultiplier.toFixed(2).padStart(8)}x RT | Node ${process.version} ${process.platform}\n`;

	await appendFile(logPath, line);
}
