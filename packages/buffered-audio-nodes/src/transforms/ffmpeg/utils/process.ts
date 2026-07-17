import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Block } from "@buffered-audio/core";

export const STDERR_CAP_BYTES = 64 * 1024;

export interface FfmpegChildHandle {
	readonly child: ChildProcessWithoutNullStreams;
	readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnFfmpegOptions {
	readonly ffmpegPath: string;
	readonly args: ReadonlyArray<string>;
	readonly onStderr: (chunk: Buffer) => void;
	readonly onStdinError: (error: Error & { code?: string }) => void;
}

export function spawnFfmpegChild(options: SpawnFfmpegOptions): FfmpegChildHandle {
	const child = spawn(options.ffmpegPath, [...options.args], { stdio: ["pipe", "pipe", "pipe"] });

	child.stderr.on("data", options.onStderr);
	child.stdin.on("error", options.onStdinError);

	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});

	return { child, exitPromise };
}

export function buildInputArgs(sampleRate: number, channels: number): Array<string> {
	return ["-f", "f32le", "-ar", String(sampleRate), "-ac", String(channels), "-i", "pipe:0"];
}

export function buildOutputArgs(outputSampleRate: number, channels: number): Array<string> {
	return ["-f", "f32le", "-ar", String(outputSampleRate), "-ac", String(channels), "pipe:1"];
}

export function appendStderr(current: string, chunk: Buffer): string {
	if (current.length >= STDERR_CAP_BYTES) return current;

	const remaining = STDERR_CAP_BYTES - current.length;
	const text = chunk.toString("utf8");

	return current + (text.length > remaining ? text.slice(0, remaining) : text);
}

export interface StdoutFrames {
	readonly block: Block | undefined;
	readonly stash: Buffer;
	readonly frameCount: number;
}

export function parseStdoutFrames(stash: Buffer, bytes: Buffer, channels: number, offset: number, sampleRate: number): StdoutFrames {
	const merged = stash.length > 0 ? Buffer.concat([stash, bytes]) : bytes;
	const frameBytes = channels * 4;

	if (frameBytes === 0) {
		return { block: undefined, stash: merged, frameCount: 0 };
	}

	const completeBytes = merged.length - (merged.length % frameBytes);

	if (completeBytes === 0) {
		return { block: undefined, stash: merged, frameCount: 0 };
	}

	const frameCount = completeBytes / frameBytes;
	const totalFloats = completeBytes / 4;

	let floatView: Float32Array;

	if ((merged.byteOffset % 4) === 0) {
		floatView = new Float32Array(merged.buffer, merged.byteOffset, totalFloats);
	} else {
		const aligned = Buffer.allocUnsafe(completeBytes);

		merged.copy(aligned, 0, 0, completeBytes);
		floatView = new Float32Array(aligned.buffer, aligned.byteOffset, totalFloats);
	}

	const samples: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		samples.push(new Float32Array(frameCount));
	}

	for (let frame = 0; frame < frameCount; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			const channelArray = samples[channel];

			if (channelArray) {
				channelArray[frame] = floatView[frame * channels + channel] ?? 0;
			}
		}
	}

	const block: Block = {
		samples,
		offset,
		sampleRate,
		bitDepth: 32,
	};

	return { block, stash: merged.subarray(completeBytes), frameCount };
}
