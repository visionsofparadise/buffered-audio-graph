import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "../../block";
import { awaitStreamClose } from "./await-stream-close";
import { buildBlock, deinterleave, pullBytes } from "./block-io";
import { ReverseBlockReader } from "./reverse-block-reader";

const HIGH_WATER_MARK = 10 * 1024 * 1024;

// reset() overwrites in place; bytes past the new write region remain until overwritten.
export class BlockBuffer {
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

	private reverseReaders = new Set<ReverseBlockReader>();

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
			for (let channel = 0; channel < channels; channel++) {
				const sourceSamples = samples[channel];

				interleaved[frame * channels + channel] = sourceSamples ? (sourceSamples[frame] ?? 0) : 0;
			}
		}

		const writeBuffer = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
		const ws = this.ensureWriteStream();
		const ok = ws.write(writeBuffer);

		if (!ok) {
			await new Promise<void>((resolve) => ws.once("drain", () => resolve()));
		}

		this.writePositionByte += writeBuffer.length;

		const writtenFrames = Math.floor(this.writePositionByte / (this._channels * 4));

		if (writtenFrames > this._frames) this._frames = writtenFrames;
	}

	async flushWrites(): Promise<void> {
		await this.endWriteStream();
	}

	async openReverseReader(): Promise<ReverseBlockReader> {
		await this.flushWrites();

		const reader = new ReverseBlockReader(this.tempPath, { frames: this._frames, channels: this._channels, sampleRate: this._sampleRate, bitDepth: this._bitDepth }, undefined, this);

		this.reverseReaders.add(reader);

		return reader;
	}

	deregisterReverseReader(reader: ReverseBlockReader): void {
		this.reverseReaders.delete(reader);
	}

	private async closeReverseReaders(): Promise<void> {
		const readers = [...this.reverseReaders];

		this.reverseReaders.clear();

		for (const reader of readers) await reader.close().catch(() => undefined);
	}

	async read(frames: number): Promise<Block> {
		const channels = this._channels;
		const startFrame = this.framesReadInSession;

		if (channels === 0 || frames <= 0 || this._frames === 0) {
			return buildBlock([], startFrame, this._sampleRate, this._bitDepth);
		}

		const bytesPerFrame = channels * 4;
		const rs = this.ensureReadStream();
		const readBuffer = await pullBytes(rs, () => rs.destroyed || this.readStreamEnded, frames * bytesPerFrame);
		const actualFrames = Math.floor(readBuffer.length / bytesPerFrame);

		if (actualFrames <= 0) return buildBlock([], startFrame, this._sampleRate, this._bitDepth);

		this.framesReadInSession += actualFrames;

		const out = deinterleave(readBuffer, channels);

		return buildBlock(out, startFrame, this._sampleRate, this._bitDepth);
	}

	async *iterate(frames: number): AsyncIterableIterator<Block> {
		for (;;) {
			const block = await this.read(frames);

			if ((block.samples[0]?.length ?? 0) === 0) return;

			yield block;
		}
	}

	async reset(): Promise<void> {
		await this.endWriteStream();
		await this.endReadStream();

		this.writePositionByte = 0;
	}

	async clear(): Promise<void> {
		await this.endWriteStream();
		await this.endReadStream();
		await this.closeReverseReaders();

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
		await this.closeReverseReaders();

		if (this.tempPath) {
			await unlink(this.tempPath).catch(() => undefined);

			this.tempPath = undefined;
		}

		this.tempFileExists = false;
		this.writePositionByte = 0;
		this._frames = 0;
		this._channels = 0;
	}

	private validateAndSetMetadata(sampleRate?: number, bitDepth?: number): void {
		if (sampleRate !== undefined) {
			if (this._sampleRate === undefined) {
				this._sampleRate = sampleRate;
			} else if (this._sampleRate !== sampleRate) {
				throw new Error(`BlockBuffer: sample rate mismatch — expected ${String(this._sampleRate)}, got ${String(sampleRate)}`);
			}
		}

		if (bitDepth !== undefined) {
			if (this._bitDepth === undefined) {
				this._bitDepth = bitDepth;
			} else if (this._bitDepth !== bitDepth) {
				throw new Error(`BlockBuffer: bit depth mismatch — expected ${String(this._bitDepth)}, got ${String(bitDepth)}`);
			}
		}
	}

	private lockChannels(target: number): void {
		if (this._channels === 0) {
			this._channels = target;
		} else if (this._channels !== target) {
			throw new Error(`BlockBuffer: channel count mismatch — buffer has ${String(this._channels)}, write supplied ${String(target)}`);
		}
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
			throw new Error("BlockBuffer: cannot read before any data has been written");
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

		// Windows keeps the temp file busy until the close event after destroy.
		await awaitStreamClose(rs);
	}
}
