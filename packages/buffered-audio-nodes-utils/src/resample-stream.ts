import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deinterleaveBuffer, interleave } from "./interleave";

const STDERR_CAP_BYTES = 64 * 1024;
const OUTPUT_HIGH_WATER_FRAMES = 65_536;
const OUTPUT_LOW_WATER_FRAMES = 32_768;

interface PendingRead {
	readonly resolve: (value: Array<Float32Array>) => void;
	readonly reject: (error: Error) => void;
	readonly frames: number;
}

export interface ResampleStreamOptions {
	readonly sourceSampleRate: number;
	readonly targetSampleRate: number;
	readonly channels: number;
}

export class ResampleStream {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly channels: number;
	private readonly bytesPerFrame: number;
	private readonly chunks: Array<Buffer> = [];
	private chunkedBytes = 0;
	private pendingDrain?: Promise<void>;
	private pendingDrainResolve?: () => void;
	private pendingDrainReject?: (error: Error) => void;
	private stdoutEnded = false;
	private exited = false;
	private exitError?: Error;
	private stderr = "";
	private pendingRead?: PendingRead;
	private closed = false;
	private stdoutPaused = false;

	constructor(ffmpegPath: string, options: ResampleStreamOptions) {
		const { sourceSampleRate, targetSampleRate, channels } = options;

		if (channels <= 0) throw new Error(`ResampleStream: channels must be > 0, got ${String(channels)}`);
		if (sourceSampleRate <= 0) throw new Error(`ResampleStream: sourceSampleRate must be > 0, got ${String(sourceSampleRate)}`);
		if (targetSampleRate <= 0) throw new Error(`ResampleStream: targetSampleRate must be > 0, got ${String(targetSampleRate)}`);

		this.channels = channels;
		this.bytesPerFrame = channels * 4;

		const args = [
			"-f", "f32le",
			"-ar", String(sourceSampleRate),
			"-ac", String(channels),
			"-i", "pipe:0",
			"-af", `aresample=${String(targetSampleRate)}:resampler=soxr:dither_method=triangular`,
			"-f", "f32le",
			"-ar", String(targetSampleRate),
			"-ac", String(channels),
			"pipe:1",
		];

		this.child = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });

		this.child.stdout.on("data", (bytes: Buffer) => this.onStdoutData(bytes));
		this.child.stdout.once("end", () => this.onStdoutEnd());
		this.child.stderr.on("data", (bytes: Buffer) => this.onStderrData(bytes));
		this.child.on("error", (error) => this.onExit(error));
		this.child.once("exit", (code) => {
			if (code !== null && code !== 0) {
				const detail = this.stderr ? `: ${this.stderr.slice(0, 1024)}` : "";

				this.onExit(new Error(`ffmpeg exited ${String(code)}${detail}`));

				return;
			}

			this.onExit();
		});
		this.child.stdin.on("error", (error: Error & { code?: string }) => {
			if (error.code === "EPIPE") {
				this.settlePendingDrain(error);

				return;
			}

			this.exitError ??= error;
			this.settlePendingDrain(error);
		});
	}

	async write(samples: Array<Float32Array>): Promise<void> {
		this.assertCanWrite();

		const frames = samples[0]?.length ?? 0;

		if (frames === 0) return;

		const interleaved = interleave(samples, frames, this.channels);
		const buf = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);

		while (this.pendingDrain) {
			await this.pendingDrain;
			this.assertCanWrite();
		}

		this.assertCanWrite();

		const ok = this.child.stdin.write(buf);

		if (!ok) {
			await this.waitForStdinDrain();
			this.assertCanWrite();
		}
	}

	async read(frames: number): Promise<Array<Float32Array>> {
		if (this.closed) throw new Error("ResampleStream: read after close");
		if (frames <= 0) return this.emptyChannels();
		if (this.pendingRead) throw new Error("ResampleStream: concurrent read");

		if (this.chunkedBytes >= this.bytesPerFrame) return this.drainOutput(frames);

		if (this.exitError) throw this.exitError;

		if (this.stdoutEnded && this.exited) return this.emptyChannels();

		return new Promise<Array<Float32Array>>((resolve, reject) => {
			this.pendingRead = { resolve, reject, frames };
			this.maybeSatisfyPendingRead();
		});
	}

	async end(): Promise<void> {
		if (this.closed) return;
		if (this.pendingDrain) await this.pendingDrain;
		if (!this.child.stdin.writableEnded) this.child.stdin.end();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;

		if (this.pendingRead) {
			this.pendingRead.reject(new Error("ResampleStream: close while read pending"));
			this.pendingRead = undefined;
		}

		this.settlePendingDrain(new Error("ResampleStream: close while write pending"));

		this.chunks.length = 0;
		this.chunkedBytes = 0;

		try {
			if (!this.child.stdin.writableEnded) {
				try {
					this.child.stdin.end();
				} catch {
					// Ignore — already ended or broken pipe.
				}
			}
		} finally {
			if (!this.exited && this.child.exitCode === null && !this.child.killed) {
				this.child.kill("SIGTERM");
			}
		}

		// Best-effort SIGKILL timer so a stuck subprocess can't hang pipeline tear-down.
		if (!this.exited) {
			await new Promise<void>((resolve) => {
				let settled = false;
				const settle = (): void => {
					if (!settled) {
						settled = true;
						resolve();
					}
				};
				const timeout = setTimeout(() => {
					this.child.kill("SIGKILL");
					settle();
				}, 5000);

				this.child.once("exit", () => {
					clearTimeout(timeout);
					settle();
				});
			});
		}
	}

	private onStdoutData(bytes: Buffer): void {
		if (this.closed) return;

		if (bytes.length > 0) {
			this.chunks.push(bytes);
			this.chunkedBytes += bytes.length;
		}

		if (!this.stdoutPaused && this.chunkedBytes >= OUTPUT_HIGH_WATER_FRAMES * this.bytesPerFrame) {
			this.stdoutPaused = true;
			this.child.stdout.pause();
		}

		this.maybeSatisfyPendingRead();
	}

	private onStdoutEnd(): void {
		this.stdoutEnded = true;
		this.maybeSatisfyPendingRead();
	}

	private onStderrData(bytes: Buffer): void {
		if (this.stderr.length >= STDERR_CAP_BYTES) return;

		const remaining = STDERR_CAP_BYTES - this.stderr.length;
		const text = bytes.toString("utf8");

		this.stderr += text.length > remaining ? text.slice(0, remaining) : text;
	}

	private onExit(error?: Error): void {
		this.exited = true;
		if (error) this.exitError ??= error;
		this.settlePendingDrain(error ?? new Error("ResampleStream: ffmpeg exited while waiting for stdin drain"));
		this.maybeSatisfyPendingRead();
	}

	private waitForStdinDrain(): Promise<void> {
		if (!this.pendingDrain) {
			this.pendingDrain = new Promise<void>((resolve, reject) => {
				this.pendingDrainResolve = resolve;
				this.pendingDrainReject = reject;
			});
			this.child.stdin.once("drain", this.onStdinDrain);
		}

		return this.pendingDrain;
	}

	private assertCanWrite(): void {
		if (this.closed) throw new Error("ResampleStream: write after close");
		if (this.exitError) throw this.exitError;
		if (this.exited) throw new Error("ResampleStream: write after ffmpeg exit");
		if (this.child.stdin.writableEnded) throw new Error("ResampleStream: write after end");
	}

	private readonly onStdinDrain = (): void => {
		this.settlePendingDrain();
	};

	private settlePendingDrain(error?: Error): void {
		if (!this.pendingDrain) return;

		const resolve = this.pendingDrainResolve;
		const reject = this.pendingDrainReject;

		this.pendingDrain = undefined;
		this.pendingDrainResolve = undefined;
		this.pendingDrainReject = undefined;
		this.child.stdin.off("drain", this.onStdinDrain);

		if (error) {
			reject?.(error);

			return;
		}

		resolve?.();
	}

	private maybeSatisfyPendingRead(): void {
		if (!this.pendingRead) return;

		const { frames, resolve, reject } = this.pendingRead;

		if (this.chunkedBytes >= this.bytesPerFrame) {
			this.pendingRead = undefined;
			resolve(this.drainOutput(frames));

			return;
		}

		if (this.exitError) {
			this.pendingRead = undefined;
			reject(this.exitError);

			return;
		}

		if (this.stdoutEnded && this.exited) {
			this.pendingRead = undefined;
			resolve(this.emptyChannels());
		}
	}

	private drainOutput(frames: number): Array<Float32Array> {
		const wantBytes = frames * this.bytesPerFrame;
		const available = Math.min(this.chunkedBytes, wantBytes);
		const completeFrames = Math.floor(available / this.bytesPerFrame);

		if (completeFrames === 0) return this.emptyChannels();

		const completeBytes = completeFrames * this.bytesPerFrame;
		const aligned = Buffer.allocUnsafe(completeBytes);
		let written = 0;

		while (written < completeBytes) {
			const head = this.chunks[0];

			if (!head) break;

			const remaining = completeBytes - written;

			if (head.length <= remaining) {
				head.copy(aligned, written, 0, head.length);
				written += head.length;
				this.chunks.shift();
				continue;
			}

			head.copy(aligned, written, 0, remaining);
			this.chunks[0] = head.subarray(remaining);
			written += remaining;
		}

		this.chunkedBytes -= completeBytes;

		if (this.stdoutPaused && this.chunkedBytes <= OUTPUT_LOW_WATER_FRAMES * this.bytesPerFrame) {
			this.stdoutPaused = false;
			this.child.stdout.resume();
		}

		return deinterleaveBuffer(aligned, this.channels);
	}

	private emptyChannels(): Array<Float32Array> {
		const out: Array<Float32Array> = [];

		for (let ch = 0; ch < this.channels; ch++) out.push(new Float32Array(0));

		return out;
	}
}
