import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	boundAfterExit,
	childExitError,
	ChildOutputHeldError,
	releaseChild,
	settledOrAborted,
	spawnChild,
	terminateChild,
	waitForChildClose,
	writeChildInput,
	type BlockBuffer,
	type ChildHandle,
} from "@buffered-audio/core";
import { deinterleaveBuffer, interleave } from "@buffered-audio/utils";
import type { Readable } from "node:stream";

const CHUNK_FRAMES = 48000;

interface VstHostTransferProgress {
	readonly framesDone: number;
	readonly framesTotal: number;
	readonly bytesDone: number;
	readonly bytesTotal: number;
}

export interface VstHostHandle {
	readonly handle: ChildHandle;
	readonly ready: Promise<void>;
}

export interface VstStage {
	readonly pluginPath: string;
	readonly pluginName?: string;
	readonly presetPath?: string;
}

const READY_LINE = "READY\n";
const READY_TIMEOUT_MS = 300_000;

export class VstHostExitedBeforeReadyError extends Error {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;

	constructor(code: number | null, signal: NodeJS.Signals | null, stderr: string) {
		super(`vst-host exited before READY (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}): ${stderr}`);
		this.name = "VstHostExitedBeforeReadyError";
		this.code = code;
		this.signal = signal;
		this.stderr = stderr;
	}
}

function readyLine(host: Pick<VstHostHandle, "handle">, stdout: Readable): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const seen: Array<Buffer> = [];
		let settled = false;

		const cleanup = (): void => {
			settled = true;
			stdout.removeListener("data", onData);
			clearTimeout(timer);
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

		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`vst-host did not emit READY within ${READY_TIMEOUT_MS}ms; a plugin may be waiting on a hidden dialog`,
				),
			);
		}, READY_TIMEOUT_MS);

		stdout.on("data", onData);
		void host.handle.exited.then((exit) => {
			if (settled) return;

			cleanup();
			reject(
				(exit.spawnError ? childExitError(host.handle.label, exit, "") : undefined) ??
					new VstHostExitedBeforeReadyError(exit.code, exit.signal, host.handle.stderrTail()),
			);
		});
	});
}

function spawnVstHost(binaryPath: string, args: ReadonlyArray<string>): VstHostHandle {
	const handle = spawnChild({ label: "vst-host", command: binaryPath, args });

	if (!handle.stdin || !handle.stdout) {
		releaseChild(handle);

		throw new Error("Failed to create vst-host stdio streams");
	}

	const ready = readyLine({ handle }, handle.stdout);

	ready.catch(() => undefined);

	return { handle, ready };
}

export async function terminateVstHost(host: VstHostHandle): Promise<void> {
	await terminateChild(host.handle.child);
	releaseChild(host.handle);
}

const CLEAN_WRAPPER_EXIT_CODES: ReadonlySet<number> = new Set([0, 1, 2]);

function isRetryableInitCrash(error: unknown): error is VstHostExitedBeforeReadyError {
	return error instanceof VstHostExitedBeforeReadyError && !CLEAN_WRAPPER_EXIT_CODES.has(error.code ?? -1);
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
			reject(signal.reason as Error);
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
			reject(signal.reason as Error);
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

function hasExited(host: VstHostHandle): boolean {
	return host.handle.child.exitCode !== null || host.handle.child.signalCode !== null;
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

		let host: VstHostHandle | undefined;

		try {
			host = spawnVstHost(binaryPath, args);

			await waitForReady(host, options.signal);

			return host;
		} catch (error) {
			if (!host) throw error;

			const retry = !options.signal?.aborted && attempt < maxAttempts && isRetryableInitCrash(error);
			let failure = error;

			if (!retry && hasExited(host)) {
				await waitForChildClose(host.handle, options.signal);

				if (error instanceof VstHostExitedBeforeReadyError)
					failure = new VstHostExitedBeforeReadyError(error.code, error.signal, host.handle.stderrTail());
			}

			await terminateVstHost(host);

			if (!retry || !isRetryableInitCrash(error)) throw failure;

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
	readonly onOutputHeld?: (error: ChildOutputHeldError) => void;
}

export async function processStreamingThroughVstHost(
	host: VstHostHandle,
	buffer: BlockBuffer,
	options: ProcessVstHostOptions,
): Promise<void> {
	const { channelCount, sampleRate, bitDepth, signal, onInputProgress, onOutputProgress, onOutputHeld } = options;
	const { handle } = host;
	const { child, stdin, stdout } = handle;
	const inputFrames = buffer.frames;
	const expectedOutputBytes = inputFrames * channelCount * 4;
	let inputFramesDone = 0;
	let onData: ((chunk: Buffer) => void) | undefined;
	let onStdoutEnd: (() => void) | undefined;

	if (!stdin || !stdout) throw new Error("vst-host has no stdio streams");

	const onAbort = (): void => {
		if (child.exitCode !== null || child.signalCode !== null) return;

		try {
			child.kill();
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
		stdout.once("end", onStdoutEnd);
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

			await writeChildInput(
				handle,
				Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength),
				signal,
			);

			inputFramesDone = Math.min(inputFrames, inputFramesDone + chunkFrames);
			onInputProgress?.({
				framesDone: inputFramesDone,
				framesTotal: inputFrames,
				bytesDone: inputFramesDone * channelCount * 4,
				bytesTotal: expectedOutputBytes,
			});

			if (chunkFrames < CHUNK_FRAMES) break;
		}

		stdin.end();

		await buffer.reset();

		let outputBytesReceived = 0;
		let stdoutTail: Buffer = Buffer.alloc(0);
		let stdoutError: Error | undefined;
		const bytesPerFrame = channelCount * 4;
		let outputFramesDone = 0;
		let writeChain: Promise<void> = Promise.resolve();

		const collect = (chunk: Buffer): void => {
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

		onData = collect;
		stdout.on("data", collect);

		let held: ChildOutputHeldError | undefined;

		try {
			await boundAfterExit(handle, settledOrAborted(stdoutEnd, signal));
		} catch (error) {
			if (!(error instanceof ChildOutputHeldError)) throw error;

			held = error;
			stdout.removeListener("data", collect);
			releaseChild(handle);
		} finally {
			stdout.removeListener("data", collect);

			await writeChain;
		}

		const exit = await settledOrAborted(host.handle.exited, signal);

		if (!held) await waitForChildClose(handle, signal);

		signal?.throwIfAborted();

		if (stdoutError !== undefined) throw stdoutError;

		const exitFailure = childExitError(handle.label, exit, handle.stderrTail());

		if (exitFailure) throw exitFailure;

		const stdinFailure = handle.stdinError();

		if (stdinFailure) throw stdinFailure;

		const complete = outputBytesReceived === expectedOutputBytes && stdoutTail.length === 0;

		if (held) {
			if (!complete) throw held;

			onOutputHeld?.(held);
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

		if (onData) stdout.removeListener("data", onData);

		if (onStdoutEnd) stdout.removeListener("end", onStdoutEnd);
	}
}
