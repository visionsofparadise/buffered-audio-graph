import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deinterleaveBuffer, interleave } from "@buffered-audio/utils";
import { waitForDrain } from "../../../utils/ffmpeg";
import type { BlockBuffer } from "@buffered-audio/core";

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
	readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
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
	const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
		proc.once("close", (code, signal) => resolve({ code, signal }));
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

	return { proc, stdin, stdout, stderr, ready, exited, getStderrTail };
}

export async function terminateVstHost(handle: VstHostHandle): Promise<void> {
	if (handle.proc.exitCode === null && handle.proc.signalCode === null) handle.proc.kill();

	await handle.exited;
}

const CLEAN_WRAPPER_EXIT_CODES: ReadonlySet<number> = new Set([0, 1, 2]);

function isRetryableInitCrash(error: unknown): error is VstHostExitedBeforeReadyError {
	return error instanceof VstHostExitedBeforeReadyError && !CLEAN_WRAPPER_EXIT_CODES.has(error.code ?? -1);
}

function abortError(): Error {
	return new DOMException("The operation was aborted", "AbortError");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));

		return;
	}

	signal.throwIfAborted();

	await new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForReady(handle: VstHostHandle, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await handle.ready;

		return;
	}

	signal.throwIfAborted();

	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => {
			reject(abortError());
		};

		signal.addEventListener("abort", onAbort, { once: true });
	});

	try {
		await Promise.race([handle.ready, aborted]);
		signal.throwIfAborted();
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

export interface SpawnVstHostReadyOptions {
	readonly maxAttempts?: number;
	readonly backoffMs?: number;
	readonly signal?: AbortSignal;
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
		options.signal?.throwIfAborted();

		const handle = spawnVstHost(binaryPath, args);

		try {
			await waitForReady(handle, options.signal);

			return handle;
		} catch (error) {
			await terminateVstHost(handle);

			if (options.signal?.aborted) throw error;

			if (attempt >= maxAttempts || !isRetryableInitCrash(error)) throw error;

			options.onRetry?.(attempt, error);
			await delay(backoffMs, options.signal);
		}
	}

	throw new Error(`spawnVstHostReady: exhausted ${maxAttempts} attempts without a result`);
}

export async function writeStagesJson(stages: ReadonlyArray<VstStage>, temporaryDirectory: string): Promise<string> {
	const path = join(temporaryDirectory, `vst3-stages-${randomUUID()}.json`);

	await writeFile(path, JSON.stringify(stages));

	return path;
}

export interface ProcessVstHostOptions {
	readonly channelCount: number;
	readonly sampleRate: number;
	readonly bitDepth?: number;
	readonly signal?: AbortSignal;
	readonly onInputProgress?: (progress: VstHostTransferProgress) => void;
	readonly onOutputProgress?: (progress: VstHostTransferProgress) => void;
}

export async function processStreamingThroughVstHost(
	handle: VstHostHandle,
	buffer: BlockBuffer,
	options: ProcessVstHostOptions,
): Promise<void> {
	const { channelCount, sampleRate, bitDepth, signal, onInputProgress, onOutputProgress } = options;
	const inputFrames = buffer.frames;
	const expectedOutputBytes = inputFrames * channelCount * 4;
	let inputFramesDone = 0;
	let onData: ((chunk: Buffer) => void) | undefined;
	let onStdoutEnd: (() => void) | undefined;

	const onAbort = (): void => {
		if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) return;

		try {
			handle.proc.kill();
		} catch {
			return;
		}
	};

	if (signal?.aborted) {
		onAbort();
		signal.throwIfAborted();
	}

	signal?.addEventListener("abort", onAbort, { once: true });

	const stdoutEnd = new Promise<void>((resolve) => {
		onStdoutEnd = resolve;
		handle.stdout.once("end", onStdoutEnd);
	});

	try {
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

		onData = (chunk: Buffer): void => {
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

		const exit = await handle.exited;

		signal?.throwIfAborted();

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
	} finally {
		signal?.removeEventListener("abort", onAbort);

		if (onData) handle.stdout.removeListener("data", onData);

		if (onStdoutEnd) handle.stdout.removeListener("end", onStdoutEnd);
	}
}
