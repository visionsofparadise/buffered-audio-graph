import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChunkBuffer } from "@buffered-audio/core";
import { deinterleaveBuffer, interleave } from "@buffered-audio/utils";
import { waitForDrain } from "../../../utils/ffmpeg";

/**
 * JS-side streaming-chunk granularity for the vst-host stdin/stdout pipes.
 * `~1 second` at 48 kHz stereo (≈384 KB f32le interleaved) — bounds JS-heap
 * cost of each interleave/deinterleave round trip independent of source
 * length. The vst-host subprocess still buffers the whole interleaved input
 * internally (Pedalboard offline mode needs full input before producing
 * output, due to whole-chain delay compensation), but that's the
 * subprocess's RAM, not ours.
 */
const CHUNK_FRAMES = 48000;

export interface VstHostHandle {
	readonly proc: ChildProcess;
	readonly stdin: NodeJS.WritableStream;
	readonly stdout: NodeJS.ReadableStream;
	readonly stderr: NodeJS.ReadableStream;
	readonly ready: Promise<void>;
	readonly stderrChunks: Array<Buffer>;
}

export interface VstStage {
	readonly pluginPath: string;
	readonly pluginName?: string;
	readonly presetPath?: string;
	/**
	 * Optional parameter overrides applied after `presetPath` loads. Keys map
	 * to Pedalboard parameter names exposed by the plugin (lowercase / snake-
	 * cased identifiers — see `plugin.parameters` in Pedalboard). Useful for
	 * plugins whose on-disk preset format Pedalboard's `load_preset` rejects
	 * (e.g. Waves XPst inside a VST3 wrapper) but whose parameter surface is
	 * reachable directly.
	 */
	readonly parameters?: Readonly<Record<string, number | string | boolean>>;
}

const READY_LINE = "READY\n";
// 5-minute floor accommodates chains of heavy plugins (iZotope RX, Waves
// shells, Neutron) where each plugin's instantiation can take several
// seconds. Empirically a 7-plugin chain of those vendors loads in ~60s on
// a warm Windows box; the floor is generous to absorb cold-start variance
// and authorization checks. The READY signal is bounded by plugin-load
// cost, not audio length, so a single conservative cap is appropriate.
const READY_TIMEOUT_MS = 300_000;

/**
 * Rejection of {@link VstHostHandle.ready} when the subprocess exits before
 * printing `READY` — it died during plugin load/init, before any audio was
 * written. Carries the structured exit `code` so callers can distinguish a
 * hard native crash (e.g. an iZotope `0xC0000005` access violation, exit code
 * `3221225477`) from the wrapper's own clean error exits (1 = plugin/preset
 * load failure, 2 = bad CLI args).
 */
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

/**
 * Spawn the vst-host subprocess and resolve `ready` once the wrapper prints
 * `READY\n` on stdout. Stderr is captured into `stderrChunks` for diagnostics.
 *
 * The caller is responsible for awaiting `ready` before writing audio to
 * stdin — without that, the first write may race the plugin chain load.
 */
export function spawnVstHost(binaryPath: string, args: ReadonlyArray<string>): VstHostHandle {
	const proc: ChildProcess = spawn(binaryPath, [...args], {
		stdio: ["pipe", "pipe", "pipe"],
	});

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new Error("Failed to create vst-host stdio streams");
	}

	const stdin = proc.stdin;
	const stdout = proc.stdout;
	const stderr = proc.stderr;
	const stderrChunks: Array<Buffer> = [];

	stderr.on("data", (chunk: Buffer) => {
		stderrChunks.push(chunk);
	});

	const ready = new Promise<void>((resolve, reject) => {
		// Buffer stdout bytes until we see `READY\n`. Anything after the newline
		// belongs to the audio stream and must be preserved — push it back as a
		// synthetic `data` event so downstream readers see it.
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
			const stderrOutput = Buffer.concat(stderrChunks).toString();

			fail(new VstHostExitedBeforeReadyError(code, stderrOutput));
		};

		const timer = setTimeout(() => {
			fail(new Error(`vst-host did not emit READY within ${READY_TIMEOUT_MS}ms`));
		}, READY_TIMEOUT_MS);

		stdout.on("data", onData);
		proc.once("error", onError);
		proc.once("close", onClose);
	});

	stdin.on("error", () => {
		// EPIPE swallowed; surfaced via stderr / exit code.
	});

	return { proc, stdin, stdout, stderr, ready, stderrChunks };
}

/**
 * Exit codes `vst-host` uses for its own *deterministic* errors: 0 = clean,
 * 1 = plugin/preset load failure, 2 = bad CLI args. A before-READY exit with
 * any other code (including `null` from a signal, or a native crash code like
 * `3221225477` = `0xC0000005`) is a non-deterministic init crash, safe to
 * retry — the crash always precedes any stdin write, so re-spawning is
 * idempotent.
 */
const CLEAN_WRAPPER_EXIT_CODES: ReadonlySet<number> = new Set([0, 1, 2]);

function isRetryableInitCrash(error: unknown): error is VstHostExitedBeforeReadyError {
	return error instanceof VstHostExitedBeforeReadyError && !CLEAN_WRAPPER_EXIT_CODES.has(error.code ?? -1);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SpawnVstHostReadyOptions {
	/** Total spawn attempts before giving up (default 5). */
	readonly maxAttempts?: number;
	/** Delay between a crash and the next spawn, in ms (default 750). */
	readonly backoffMs?: number;
	/** Invoked before each retry with the 1-based attempt that just failed. */
	readonly onRetry?: (failedAttempt: number, error: VstHostExitedBeforeReadyError) => void;
}

/**
 * Spawn `vst-host` and resolve once it prints `READY`, retrying the spawn on a
 * non-deterministic init crash (see {@link isRetryableInitCrash}).
 *
 * iZotope plugins (Neutron especially) intermittently crash the subprocess
 * during plugin init with a Windows access violation (`0xC0000005`, exit code
 * `3221225477`) — non-deterministic, and always before `READY`, so no audio
 * has been written and re-spawning is safe. Deterministic failures (bad
 * plugin path / preset = exit 1, bad args = exit 2) and the `READY` timeout
 * are NOT retried — they would fail identically on every attempt.
 *
 * Returns a live handle whose `ready` has already resolved; the caller then
 * drives stdin/stdout as usual.
 */
export async function spawnVstHostReady(binaryPath: string, args: ReadonlyArray<string>, options: SpawnVstHostReadyOptions = {}): Promise<VstHostHandle> {
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

	// Unreachable for maxAttempts >= 1: the loop returns a ready handle or
	// throws above. Guards the degenerate maxAttempts < 1 case explicitly.
	throw new Error(`spawnVstHostReady: exhausted ${maxAttempts} attempts without a result`);
}

/**
 * Write `stages` as JSON to a fresh temp file. Returns the file path and an
 * async cleanup function that removes the parent temp directory.
 */
export async function writeStagesJson(stages: ReadonlyArray<VstStage>): Promise<{ path: string; cleanup: () => Promise<void> }> {
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

/**
 * Stream the audio buffer through the vst-host subprocess in offline mode,
 * mutating `buffer` in place. No temp ChunkBuffer, no double-disk-usage
 * during a stream-copy phase.
 *
 * Sequence:
 * 1. Drain `buffer` to stdin: loop `buffer.read(CHUNK_FRAMES)` → interleave →
 *    write to subprocess stdin (respecting backpressure via `waitForDrain`).
 * 2. `end()` stdin — Pedalboard's offline mode reads stdin to EOF before it
 *    starts producing stdout (whole-chain plugin delay compensation spans
 *    the entire input).
 * 3. `buffer.reset()` — rewind read + write stream positions to 0. Subsequent
 *    writes (Phase 4) place samples at position 0, overwriting the input
 *    data in place. No explicit data drop needed — Pedalboard offline mode
 *    returns the same number of output frames as input frames, so every
 *    input byte is overwritten by output.
 * 4. Drain stdout incrementally back into `buffer`: each `data` event is
 *    f32le-aligned (carrying any leftover partial frame across events), then
 *    deinterleaved and appended via `buffer.write(...)`.
 *
 * The JS-side memory bound is `CHUNK_FRAMES * channelCount * 4` bytes for
 * input streaming plus the buffer's own 10 MB write scratch — independent of
 * source length. Disk usage stays at 1× source size (vs. the 2× transient
 * peak that a temp-buffer + stream-copy-back pattern would incur).
 *
 * The vst-host subprocess still buffers the whole interleaved input
 * internally (Pedalboard's offline-mode constraint), but that's its own
 * RAM, not the Node process's heap.
 *
 * Pedalboard's offline mode (`reset=True`) handles plugin delay compensation
 * across the whole chain, so the wrapper writes exactly
 * `inputFrames * channelCount * 4` bytes on stdout before closing it.
 */
export async function processStreamingThroughVstHost(
	handle: VstHostHandle,
	buffer: ChunkBuffer,
	channelCount: number,
	sampleRate: number,
	bitDepth: number | undefined,
): Promise<void> {
	const inputFrames = buffer.frames;
	const expectedOutputBytes = inputFrames * channelCount * 4;

	const stdoutEnd = new Promise<void>((resolve) => {
		handle.stdout.once("end", () => resolve());
	});

	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		handle.proc.once("close", (code, signal) => resolve({ code, signal }));
	});

	// === Phase 1: drain `buffer` to subprocess stdin. ===
	// Pedalboard's offline mode buffers stdin internally and only starts
	// producing stdout after stdin closes, so we cannot interleave reads/
	// writes productively — but we CAN avoid materialising the whole input
	// as a single JS-side Float32Array.
	await buffer.reset();

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) break;

		const channelArrays: Array<Float32Array> = [];

		for (let ch = 0; ch < channelCount; ch++) {
			channelArrays.push(chunk.samples[ch] ?? new Float32Array(chunkFrames));
		}

		const interleaved = interleave(channelArrays, chunkFrames, channelCount);
		const buf = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
		const canWrite = handle.stdin.write(buf);

		if (!canWrite) {
			await waitForDrain(handle.proc, handle.stdin);
		}

		if (chunkFrames < CHUNK_FRAMES) break;
	}

	handle.stdin.end();

	// === Phase 2: rewind the buffer's stream positions. ===
	// `reset()` rewinds read + write cursors to position 0. The next write
	// (Phase 3 below) places samples at position 0, overwriting the input
	// data we just streamed to the subprocess. Pedalboard offline mode
	// guarantees the same number of output frames as input frames, so the
	// final buffer contents are exactly the output (no stale tail bytes).
	await buffer.reset();

	// === Phase 3: drain stdout incrementally into `buffer`. ===
	// Each `data` event may deliver an unaligned byte count (the OS pipe
	// boundary is arbitrary), so accumulate a tail of leftover bytes between
	// successive f32le frames and emit only aligned chunks to the buffer. A
	// serial promise chain holds each chunk's async write so subsequent
	// `data` events queue behind it — `ChunkBuffer.write` is not safe under
	// concurrent callers.
	let outputBytesReceived = 0;
	let stdoutTail: Buffer = Buffer.alloc(0);
	let stdoutError: Error | undefined;
	const bytesPerFrame = channelCount * 4;
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
			.then(() => buffer.write(channels, sampleRate, bitDepth))
			.catch((error: unknown) => {
				stdoutError ??= error instanceof Error ? error : new Error(String(error));
			});
	};

	handle.stdout.on("data", onData);

	await stdoutEnd;
	// All `data` callbacks have run; drain the serial write chain so every
	// deinterleaved chunk has landed in `buffer` before we validate.
	await writeChain;
	const exit = await exited;

	if (stdoutError !== undefined) throw stdoutError;

	if (exit.code !== 0) {
		const stderrOutput = Buffer.concat(handle.stderrChunks).toString();

		throw new Error(`vst-host exited with code ${exit.code ?? "null"}${exit.signal ? ` (signal ${exit.signal})` : ""}: ${stderrOutput}`);
	}

	if (outputBytesReceived !== expectedOutputBytes) {
		throw new Error(`vst-host returned ${outputBytesReceived} bytes, expected ${expectedOutputBytes} (${inputFrames} frames × ${channelCount} channels × 4)`);
	}

	if (stdoutTail.length !== 0) {
		throw new Error(`vst-host returned an unaligned trailing fragment of ${stdoutTail.length} bytes (not a multiple of ${bytesPerFrame})`);
	}

	await buffer.flushWrites();
}
