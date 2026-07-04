/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight interleave loops with bounds-checked typed array access */
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioChunk } from "./node";

const HIGH_WATER_MARK = 10 * 1024 * 1024;

// `reset()` overwrites the file in place without truncating — bytes past the new write region persist until overwritten.
export class ChunkBuffer {
	private _frames = 0;
	private _channels = 0;
	private _sampleRate?: number;
	private _bitDepth?: number;

	private tempPath?: string;
	private tempFileExists = false;

	private writeStream?: WriteStream;
	private writeStreamFinished?: Promise<void>;
	private writePositionByte = 0;

	private readStream?: ReadStream;
	private readStreamEnded = false;
	private framesReadInSession = 0;

	get frames(): number {
		return this._frames;
	}

	get channels(): number {
		return this._channels;
	}

	get sampleRate(): number | undefined {
		return this._sampleRate;
	}

	get bitDepth(): number | undefined {
		return this._bitDepth;
	}

	setSampleRate(rate: number): void {
		this._sampleRate = rate;
	}

	setBitDepth(depth: number): void {
		this._bitDepth = depth;
	}

	async write(samples: Array<Float32Array>, sampleRate?: number, bitDepth?: number): Promise<void> {
		const duration = samples[0]?.length ?? 0;

		if (duration === 0) return;

		this.validateAndSetMetadata(sampleRate, bitDepth);
		this.lockChannels(samples.length);

		const channels = this._channels;
		const interleaved = new Float32Array(duration * channels);

		for (let frame = 0; frame < duration; frame++) {
			for (let ch = 0; ch < channels; ch++) {
				const src = samples[ch];

				interleaved[frame * channels + ch] = src ? (src[frame] ?? 0) : 0;
			}
		}

		const buf = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
		const ws = this.ensureWriteStream();
		const ok = ws.write(buf);

		if (!ok) {
			await new Promise<void>((resolve) => ws.once("drain", () => resolve()));
		}

		this.writePositionByte += buf.length;

		const writtenFrames = Math.floor(this.writePositionByte / (this._channels * 4));

		if (writtenFrames > this._frames) this._frames = writtenFrames;
	}

	async flushWrites(): Promise<void> {
		await this.endWriteStream();
	}

	async read(frames: number): Promise<AudioChunk> {
		const channels = this._channels;
		const startFrame = this.framesReadInSession;

		if (channels === 0 || frames <= 0 || this._frames === 0) {
			return this.buildAudioChunk([], startFrame);
		}

		const bytesPerFrame = channels * 4;
		const bytesNeeded = frames * bytesPerFrame;
		const buf = await this.pullBytes(bytesNeeded);
		const actualFrames = Math.floor(buf.length / bytesPerFrame);

		if (actualFrames <= 0) return this.buildAudioChunk([], startFrame);

		this.framesReadInSession += actualFrames;

		const interleaved = new Float32Array(buf.buffer, buf.byteOffset, actualFrames * channels);
		const out: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) out.push(new Float32Array(actualFrames));

		for (let frame = 0; frame < actualFrames; frame++) {
			const base = frame * channels;

			for (let ch = 0; ch < channels; ch++) {
				out[ch]![frame] = interleaved[base + ch]!;
			}
		}

		return this.buildAudioChunk(out, startFrame);
	}

	async reset(): Promise<void> {
		await this.endWriteStream();
		await this.endReadStream();
		this.writePositionByte = 0;
	}

	async clear(): Promise<void> {
		await this.endWriteStream();
		await this.endReadStream();

		if (this.tempPath) {
			await unlink(this.tempPath).catch(() => undefined);
			this.tempPath = undefined;
		}

		this.tempFileExists = false;
		this.writePositionByte = 0;
		this._frames = 0;
	}

	async close(): Promise<void> {
		await this.endWriteStream();
		await this.endReadStream();

		if (this.tempPath) {
			await unlink(this.tempPath).catch(() => undefined);
			this.tempPath = undefined;
		}

		this.tempFileExists = false;
		this.writePositionByte = 0;
		this._frames = 0;
		this._channels = 0;
	}

	tempFilePath(): string | undefined {
		return this.tempPath;
	}

	private validateAndSetMetadata(sampleRate?: number, bitDepth?: number): void {
		if (sampleRate !== undefined) {
			if (this._sampleRate === undefined) {
				this._sampleRate = sampleRate;
			} else if (this._sampleRate !== sampleRate) {
				throw new Error(`ChunkBuffer: sample rate mismatch — expected ${String(this._sampleRate)}, got ${String(sampleRate)}`);
			}
		}

		if (bitDepth !== undefined) {
			if (this._bitDepth === undefined) {
				this._bitDepth = bitDepth;
			} else if (this._bitDepth !== bitDepth) {
				throw new Error(`ChunkBuffer: bit depth mismatch — expected ${String(this._bitDepth)}, got ${String(bitDepth)}`);
			}
		}
	}

	private lockChannels(target: number): void {
		if (this._channels === 0) {
			this._channels = target;
		} else if (this._channels !== target) {
			throw new Error(`ChunkBuffer: channel count mismatch — buffer has ${String(this._channels)}, write supplied ${String(target)}`);
		}
	}

	private buildAudioChunk(samples: Array<Float32Array>, offset: number): AudioChunk {
		return { samples, offset, sampleRate: this._sampleRate ?? 0, bitDepth: this._bitDepth ?? 0 };
	}

	private ensureTempPath(): string {
		this.tempPath ??= join(tmpdir(), `chunk-buffer-${randomUUID()}.bin`);

		return this.tempPath;
	}

	private ensureWriteStream(): WriteStream {
		if (this.writeStream) return this.writeStream;

		const path = this.ensureTempPath();
		const flags = this.tempFileExists ? "r+" : "w";
		const ws = createWriteStream(path, { flags, start: this.writePositionByte, highWaterMark: HIGH_WATER_MARK });
		const finished = new Promise<void>((resolve, reject) => {
			ws.once("finish", () => resolve());
			ws.once("error", (error) => reject(error));
		});

		finished.catch(() => undefined);

		this.writeStream = ws;
		this.writeStreamFinished = finished;
		this.tempFileExists = true;

		return ws;
	}

	private async endWriteStream(): Promise<void> {
		const ws = this.writeStream;
		const finished = this.writeStreamFinished;

		if (!ws || !finished) return;

		this.writeStream = undefined;
		this.writeStreamFinished = undefined;
		ws.end();
		await finished;
	}

	private ensureReadStream(): ReadStream {
		if (this.readStream) return this.readStream;
		if (!this.tempPath) {
			throw new Error("ChunkBuffer: cannot read before any data has been written");
		}

		const rs = createReadStream(this.tempPath, { highWaterMark: HIGH_WATER_MARK });

		this.readStream = rs;
		this.readStreamEnded = false;
		this.framesReadInSession = 0;
		rs.once("end", () => {
			this.readStreamEnded = true;
		});
		rs.once("error", () => {
			this.readStreamEnded = true;
		});

		return rs;
	}

	private async endReadStream(): Promise<void> {
		const rs = this.readStream;

		if (!rs) return;

		this.readStream = undefined;
		this.readStreamEnded = false;
		this.framesReadInSession = 0;
		rs.destroy();

		// On Windows the file descriptor isn't released until 'close' fires —
		// without this await, a subsequent `unlink()` (in clear/close) can race
		// the stream's tear-down and fail with EBUSY.
		if (!rs.closed) {
			await new Promise<void>((resolve) => {
				rs.once("close", () => resolve());
			});
		}
	}

	private async pullBytes(bytesNeeded: number): Promise<Buffer> {
		const rs = this.ensureReadStream();
		const chunks: Array<Buffer> = [];
		let collected = 0;

		while (collected < bytesNeeded) {
			const chunk = rs.read() as Buffer | null;

			if (chunk !== null) {
				const remaining = bytesNeeded - collected;

				if (chunk.length <= remaining) {
					chunks.push(chunk);
					collected += chunk.length;
				} else {
					chunks.push(chunk.subarray(0, remaining));
					collected += remaining;
					rs.unshift(chunk.subarray(remaining));
				}

				continue;
			}

			if (this.readStreamEnded) break;

			await new Promise<void>((resolve) => {
				const onReadable = (): void => {
					rs.off("end", onEnd);
					resolve();
				};
				const onEnd = (): void => {
					rs.off("readable", onReadable);
					resolve();
				};

				rs.once("readable", onReadable);
				rs.once("end", onEnd);
			});
		}

		if (chunks.length === 0) return Buffer.alloc(0);
		if (chunks.length === 1) return chunks[0]!;

		return Buffer.concat(chunks);
	}
}
