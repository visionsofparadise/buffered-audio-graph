/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight interleave loops with bounds-checked typed array access */
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioChunk } from "./node";

const HIGH_WATER_MARK = 10 * 1024 * 1024;
const REVERSE_STRIPE_BYTES = 10 * 1024 * 1024;

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

	private reverseReaders = new Set<ReverseChunkReader>();

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

	// Opens a read-only reverse view over this buffer's temp file. Flushes pending writes first, then
	// snapshots frames/channels/sampleRate/bitDepth so the reader is stable against later reads on the
	// source. The reader is registered here and closed by clear()/close() (Windows blocks unlink while a
	// handle is open — same EBUSY guard the forward read stream uses in endReadStream). See the
	// ReverseChunkReader class comment for the full borrow contract.
	async openReverseReader(): Promise<ReverseChunkReader> {
		await this.flushWrites();

		const reader = new ReverseChunkReader(
			this.tempPath,
			{ frames: this._frames, channels: this._channels, sampleRate: this._sampleRate, bitDepth: this._bitDepth },
			REVERSE_STRIPE_BYTES,
			this,
		);

		this.reverseReaders.add(reader);

		return reader;
	}

	// Called by a factory-created reader from its close() so it deregisters itself. Idempotent.
	deregisterReverseReader(reader: ReverseChunkReader): void {
		this.reverseReaders.delete(reader);
	}

	private async closeReverseReaders(): Promise<void> {
		const readers = [...this.reverseReaders];

		this.reverseReaders.clear();

		for (const reader of readers) {
			// Closing from teardown must never throw even if the reader is already closed.
			await reader.close().catch(() => undefined);
		}
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

// A read-only reverse view over a source ChunkBuffer's temp file. It BORROWS, it does not OWN: it holds
// its own FileHandle, never unlinks the file, and never mutates the source buffer. Its validity ends at
// the next write/reset/clear/close on the source — the snapshot of frames/channels captured at open no
// longer describes the file after those operations. There is no invalidation machinery: both call sites
// open the reader, drain it to start-of-file, and close it with no interleaved writes on the source, so
// the borrow window is unambiguous. The source registers the reader (when created via
// openReverseReader) and closes it in clear()/close() before unlinking, because on Windows an open
// handle blocks unlink with EBUSY — the same discipline the forward read stream applies in endReadStream.
//
// The read cursor starts at `frames` and walks toward 0. read(n) serves min(n, remaining) frames covering
// source-frame window [cursor - m, cursor) returned in REVERSE time order (output frame 0 = source frame
// cursor - 1, …), then advances the cursor toward 0. At cursor 0 read returns an empty chunk.
export class ReverseChunkReader {
	readonly frames: number;
	readonly channels: number;

	private readonly path?: string;
	private readonly sampleRate?: number;
	private readonly bitDepth?: number;
	private readonly bytesPerFrame: number;
	private readonly stripeBytes: number;
	private readonly parent?: ChunkBuffer;

	private cursorFrame: number;
	private closed = false;

	private handle?: FileHandle;

	// The stripe holds a contiguous raw interleaved window of the file covering byte range
	// [stripeStartByte, stripeStartByte + stripe.length). Empty until the first read populates it.
	private stripe = Buffer.alloc(0);
	private stripeStartByte = 0;

	constructor(
		path: string | undefined,
		meta: { frames: number; channels: number; sampleRate?: number; bitDepth?: number },
		stripeBytes = REVERSE_STRIPE_BYTES,
		parent?: ChunkBuffer,
	) {
		// A never-written source has no temp file: zero frames, every read is empty, close() is a no-op.
		this.path = path;
		this.frames = path === undefined ? 0 : meta.frames;
		this.channels = meta.channels;
		this.sampleRate = meta.sampleRate;
		this.bitDepth = meta.bitDepth;
		this.bytesPerFrame = meta.channels * 4;
		// Frame-align the stripe (a whole multiple of bytesPerFrame, at least one frame). This keeps
		// stripeStartByte on a frame — and therefore 4-byte — boundary, so read() can view the whole
		// stripe as one Float32Array and index frames out of it without a per-frame allocation.
		this.stripeBytes =
			meta.channels === 0 ? stripeBytes : Math.max(this.bytesPerFrame, Math.floor(stripeBytes / this.bytesPerFrame) * this.bytesPerFrame);
		this.parent = parent;
		this.cursorFrame = this.frames;
	}

	async read(frames: number): Promise<AudioChunk> {
		if (this.closed) {
			throw new Error("ReverseChunkReader: read() after close()");
		}

		const offset = this.frames - this.cursorFrame;

		if (this.path === undefined || this.channels === 0 || frames <= 0 || this.cursorFrame <= 0) {
			return this.buildChunk([], offset);
		}

		const count = Math.min(frames, this.cursorFrame);
		const channels = this.channels;
		const out: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) out.push(new Float32Array(count));

		// Source window is [windowStartFrame, cursorFrame); output frame `outIdx` maps to source frame
		// cursorFrame - 1 - outIdx (reverse time order). Walk the window backward in stripe-bounded runs:
		// load a stripe once, view it whole as Float32, then deinterleave every frame it holds
		// synchronously — no per-frame await or allocation. A run stops at the stripe's lowest whole
		// frame; the next iteration loads the adjacent backward stripe, so a read spanning multiple
		// stripes costs one load per stripe touched.
		const windowStartFrame = this.cursorFrame - count;
		let topFrame = this.cursorFrame - 1;

		while (topFrame >= windowStartFrame) {
			await this.ensureFrameInStripe(topFrame * this.bytesPerFrame);

			// stripeStartByte is frame-aligned (see constructor), so these divisions are exact.
			const stripeStartFloat = this.stripeStartByte / 4;
			const stripeBottomFrame = this.stripeStartByte / this.bytesPerFrame;
			const runBottomFrame = Math.max(windowStartFrame, stripeBottomFrame);
			const stripeFloats = new Float32Array(this.stripe.buffer, this.stripe.byteOffset, this.stripe.length / 4);

			for (let srcFrame = topFrame; srcFrame >= runBottomFrame; srcFrame--) {
				const floatBase = srcFrame * channels - stripeStartFloat;
				const outIdx = this.cursorFrame - 1 - srcFrame;

				for (let ch = 0; ch < channels; ch++) {
					out[ch]![outIdx] = stripeFloats[floatBase + ch]!;
				}
			}

			topFrame = runBottomFrame - 1;
		}

		this.cursorFrame = windowStartFrame;

		return this.buildChunk(out, offset);
	}

	async close(): Promise<void> {
		if (this.closed) return;

		this.closed = true;

		const handle = this.handle;

		this.handle = undefined;
		this.stripe = Buffer.alloc(0);

		if (handle) await handle.close();

		this.parent?.deregisterReverseReader(this);
	}

	// Ensures the frame beginning at `frameByte` is fully inside the current stripe, loading a fresh
	// backward-walking stripe if not.
	private async ensureFrameInStripe(frameByte: number): Promise<void> {
		const frameEndByte = frameByte + this.bytesPerFrame;
		const stripeEndByte = this.stripeStartByte + this.stripe.length;

		if (frameByte < this.stripeStartByte || frameEndByte > stripeEndByte) {
			// Load a stripe ending at the requested frame's end byte, walking backward from there.
			await this.loadStripeEndingAt(frameEndByte);
		}
	}

	// Fills the stripe with the file window [max(0, endByte - stripeBytes), endByte). A single read(n)
	// may span more than one stripe when n exceeds (or is misaligned to) the stripe; read()'s run loop
	// calls this once per stripe it touches, walking backward.
	private async loadStripeEndingAt(endByte: number): Promise<void> {
		const startByte = Math.max(0, endByte - this.stripeBytes);
		const length = endByte - startByte;
		const buf = Buffer.alloc(length);

		await this.readFully(buf, startByte);

		this.stripe = buf;
		this.stripeStartByte = startByte;
	}

	// The one centralized positioned read-fully helper. Loops on handle.read and throws on a zero-byte
	// read (unexpected EOF) — the shared fix for reverse-buffer.ts's former unchecked-bytesRead bug.
	private async readFully(target: Buffer, position: number): Promise<void> {
		const handle = await this.ensureHandle();
		let filled = 0;

		while (filled < target.length) {
			const { bytesRead } = await handle.read(target, filled, target.length - filled, position + filled);

			if (bytesRead === 0) {
				throw new Error(`ReverseChunkReader: unexpected EOF at byte ${position + filled}`);
			}

			filled += bytesRead;
		}
	}

	private async ensureHandle(): Promise<FileHandle> {
		if (this.handle) return this.handle;
		if (this.path === undefined) {
			throw new Error("ReverseChunkReader: no source file");
		}

		this.handle = await open(this.path, "r");

		return this.handle;
	}

	private buildChunk(samples: Array<Float32Array>, offset: number): AudioChunk {
		return { samples, offset, sampleRate: this.sampleRate ?? 0, bitDepth: this.bitDepth ?? 0 };
	}
}
