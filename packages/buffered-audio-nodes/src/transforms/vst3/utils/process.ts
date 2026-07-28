import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockBuffer } from "@buffered-audio/core";
import { deinterleaveBuffer, interleave } from "@buffered-audio/utils";
import { waitForDrain } from "../../../utils/ffmpeg";

const CHUNK_FRAMES = 48000;

export const DIAGNOSTIC_TAIL_BYTES = 64 * 1024;

interface VstHostTransferProgress {
	readonly framesDone: number;
	readonly framesTotal: number;
	readonly bytesDone: number;
	readonly bytesTotal: number;
}

export interface VstHostHandle {
	readonly proc: ChildProcess;
	readonly stdin: NodeJS.WritableStream;
	readonly stdout: NodeJS.ReadableStream;
	readonly stderr: NodeJS.ReadableStream;
	readonly ready: Promise<void>;
	readonly getStderrTail: () => string;
}

export interface VstStage {
	readonly pluginPath: string;
	readonly pluginName?: string;
	readonly presetPath?: string;
}

const READY_LINE = "READY\n";
const READY_TIMEOUT_MS = 300_000;

export function observeVstHostStderr(stderr: NodeJS.ReadableStream): () => string {
	let diagnosticTail: Buffer = Buffer.alloc(0);

	stderr.on("data", (chunk: Buffer) => {
		const combined = diagnosticTail.length === 0 ? chunk : Buffer.concat([diagnosticTail, chunk]);

		diagnosticTail =
			combined.length <= DIAGNOSTIC_TAIL_BYTES
				? combined
				: combined.subarray(combined.length - DIAGNOSTIC_TAIL_BYTES);
	});

	return () => diagnosticTail.toString("utf8");
}

export class VstHostExitedBeforeReadyError extends Error {
	readonly code: number | null;
	readonly stderr: string;

	constructor(code: number | null, stderr: string) {
		super(`vst-host exited before READY (code ${code ?? "null"}): ${stderr}`);
		this.name = "VstHostExitedBeforeReadyError";
		this.code = code;
		this.stderr = stderr;
	}
}

function spawnVstHost(binaryPath: string, args: ReadonlyArray<string>): VstHostHandle {
	const proc: ChildProcess = spawn(binaryPath, [...args], {
		stdio: ["pipe", "pipe", "pipe"],
	});

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new Error("Failed to create vst-host stdio streams");
	}

	const stdin = proc.stdin;
	const stdout = proc.stdout;
	const stderr = proc.stderr;
	const getStderrTail = observeVstHostStderr(stderr);

	const ready = new Promise<void>((resolve, reject) => {
		const seen: Array<Buffer> = [];

		const cleanup = (): void => {
			stdout.removeListener("data", onData);
			proc.removeListener("error", onError);
			proc.removeListener("close", onClose);
			clearTimeout(timer);
		};

		const fail = (error: Error): void => {
			cleanup();
			reject(error);
		};

		const onData = (chunk: Buffer): void => {
			seen.push(chunk);

			const combined = Buffer.concat(seen);
			const readyIndex = combined.indexOf(READY_LINE);

			if (readyIndex === -1) return;

			cleanup();

			const tail = combined.subarray(readyIndex + READY_LINE.length);

			if (tail.length > 0) {
				queueMicrotask(() => {
					stdout.emit("data", tail);
				});
			}

			resolve();
		};

		const onError = (error: Error): void => {
			fail(new Error(`vst-host failed to start: ${error.message}`));
		};

		const onClose = (code: number | null): void => {
			const stderrOutput = getStderrTail();

			fail(new VstHostExitedBeforeReadyError(code, stderrOutput));
		};

		const timer = setTimeout(() => {
			fail(new Error(`vst-host did not emit READY within ${READY_TIMEOUT_MS}ms`));
		}, READY_TIMEOUT_MS);

		stdout.on("data", onData);
		proc.once("error", onError);
		proc.once("close", onClose);
	});

	stdin.on("error", () => {});

	return { proc, stdin, stdout, stderr, ready, getStderrTail };
}

const CLEAN_WRAPPER_EXIT_CODES: ReadonlySet<number> = new Set([0, 1, 2]);

function isRetryableInitCrash(error: unknown): error is VstHostExitedBeforeReadyError {
	return error instanceof VstHostExitedBeforeReadyError && !CLEAN_WRAPPER_EXIT_CODES.has(error.code ?? -1);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SpawnVstHostReadyOptions {
	readonly maxAttempts?: number;
	readonly backoffMs?: number;
	readonly onRetry?: (failedAttempt: number, error: VstHostExitedBeforeReadyError) => void;
}

export async function spawnVstHostReady(
	binaryPath: string,
	args: ReadonlyArray<string>,
	options: SpawnVstHostReadyOptions = {},
): Promise<VstHostHandle> {
	const maxAttempts = options.maxAttempts ?? 5;
	const backoffMs = options.backoffMs ?? 750;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const handle = spawnVstHost(binaryPath, args);

		try {
			await handle.ready;

			return handle;
		} catch (error) {
			handle.proc.kill();

			if (attempt >= maxAttempts || !isRetryableInitCrash(error)) throw error;

			options.onRetry?.(attempt, error);
			await delay(backoffMs);
		}
	}

	throw new Error(`spawnVstHostReady: exhausted ${maxAttempts} attempts without a result`);
}

export async function writeStagesJson(
	stages: ReadonlyArray<VstStage>,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "vst-host-stages-"));
	const path = join(dir, "stages.json");

	await writeFile(path, JSON.stringify(stages));

	return {
		path,
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export interface ProcessVstHostOptions {
	readonly channelCount: number;
	readonly sampleRate: number;
	readonly bitDepth?: number;
	readonly onInputProgress?: (progress: VstHostTransferProgress) => void;
	readonly onOutputProgress?: (progress: VstHostTransferProgress) => void;
}

export async function processStreamingThroughVstHost(
	handle: VstHostHandle,
	buffer: BlockBuffer,
	options: ProcessVstHostOptions,
): Promise<void> {
	const { channelCount, sampleRate, bitDepth, onInputProgress, onOutputProgress } = options;
	const inputFrames = buffer.frames;
	const expectedOutputBytes = inputFrames * channelCount * 4;
	let inputFramesDone = 0;

	const stdoutEnd = new Promise<void>((resolve) => {
		handle.stdout.once("end", () => resolve());
	});

	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		handle.proc.once("close", (code, signal) => resolve({ code, signal }));
	});

	await buffer.reset();

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		const channelArrays: Array<Float32Array> = [];

		for (let channel = 0; channel < channelCount; channel++) {
			channelArrays.push(chunk.samples[channel] ?? new Float32Array(chunkFrames));
		}

		const interleaved = interleave(channelArrays, chunkFrames, channelCount);
		const interleavedBuffer = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
		const canWrite = handle.stdin.write(interleavedBuffer);

		if (!canWrite) {
			await waitForDrain(handle.proc, handle.stdin);
		}

		inputFramesDone = Math.min(inputFrames, inputFramesDone + chunkFrames);
		onInputProgress?.({
			framesDone: inputFramesDone,
			framesTotal: inputFrames,
			bytesDone: inputFramesDone * channelCount * 4,
			bytesTotal: expectedOutputBytes,
		});

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	handle.stdin.end();

	await buffer.reset();

	let outputBytesReceived = 0;
	let stdoutTail: Buffer = Buffer.alloc(0);
	let stdoutError: Error | undefined;
	const bytesPerFrame = channelCount * 4;
	let outputFramesDone = 0;
	let writeChain: Promise<void> = Promise.resolve();

	const onData = (chunk: Buffer): void => {
		if (stdoutError !== undefined) return;

		outputBytesReceived += chunk.length;
		const combined = stdoutTail.length === 0 ? chunk : Buffer.concat([stdoutTail, chunk]);
		const alignedFrames = Math.floor(combined.length / bytesPerFrame);
		const alignedBytes = alignedFrames * bytesPerFrame;

		if (alignedFrames === 0) {
			stdoutTail = combined;

			return;
		}

		const aligned = combined.subarray(0, alignedBytes);

		stdoutTail = combined.length === alignedBytes ? Buffer.alloc(0) : combined.subarray(alignedBytes);

		const channels = deinterleaveBuffer(aligned, channelCount);

		writeChain = writeChain
			.then(async () => {
				await buffer.write(channels, sampleRate, bitDepth);
				outputFramesDone = Math.min(inputFrames, outputFramesDone + alignedFrames);
				onOutputProgress?.({
					framesDone: outputFramesDone,
					framesTotal: inputFrames,
					bytesDone: outputFramesDone * bytesPerFrame,
					bytesTotal: expectedOutputBytes,
				});
			})
			.catch((error: unknown) => {
				stdoutError ??= error instanceof Error ? error : new Error(String(error));
			});
	};

	handle.stdout.on("data", onData);

	await stdoutEnd;
	await writeChain;
	const exit = await exited;

	if (stdoutError !== undefined) throw stdoutError;

	if (exit.code !== 0) {
		const stderrOutput = handle.getStderrTail();

		throw new Error(
			`vst-host exited with code ${exit.code ?? "null"}${exit.signal ? ` (signal ${exit.signal})` : ""}: ${stderrOutput}`,
		);
	}

	if (outputBytesReceived !== expectedOutputBytes) {
		throw new Error(
			`vst-host returned ${outputBytesReceived} bytes, expected ${expectedOutputBytes} (${inputFrames} frames × ${channelCount} channels × 4)`,
		);
	}

	if (stdoutTail.length !== 0) {
		throw new Error(
			`vst-host returned an unaligned trailing fragment of ${stdoutTail.length} bytes (not a multiple of ${bytesPerFrame})`,
		);
	}

	await buffer.flushWrites();
}
