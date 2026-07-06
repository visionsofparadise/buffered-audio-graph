import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceMetadata, TransformNode } from "@buffered-audio/core";
import { read } from "../sources/read";
import { write, type WavBitDepth } from "../targets/write";
import { readToBuffer } from "./read-to-buffer";

export interface TransformTestResult {
	readonly input: Array<Float32Array>;
	readonly output: Array<Float32Array>;
	readonly context: SourceMetadata;
}

export async function runTransform(inputPath: string, transform: TransformNode, options?: { outputBitDepth?: WavBitDepth }): Promise<TransformTestResult> {
	const inputResult = await readToBuffer(inputPath);
	const inputChunk = await inputResult.buffer.read(inputResult.buffer.frames);
	const inputSamples = inputChunk.samples;

	await inputResult.buffer.close();

	const tempPath = join(tmpdir(), `ban-test-${randomBytes(8).toString("hex")}.wav`);

	try {
		const source = read(inputPath);
		const target = write(tempPath, { bitDepth: options?.outputBitDepth ?? "32f" });

		source.to(transform);
		transform.to(target);

		await source.createRenderJob().render();

		const outputResult = await readToBuffer(tempPath);
		const outputChunk = await outputResult.buffer.read(outputResult.buffer.frames);
		const outputSamples = outputChunk.samples;

		await outputResult.buffer.close();

		return {
			input: inputSamples,
			output: outputSamples,
			context: inputResult.context,
		};
	} finally {
		try {
			await unlink(tempPath);
		} catch {
			// Temp file may not exist if pipeline failed before write
		}
	}
}
