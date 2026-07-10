/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight interleave loops with bounds-checked typed array access */
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

export interface Block {
	readonly samples: Array<Float32Array>;
	readonly offset: number;
	readonly sampleRate: number;
	readonly bitDepth: number;
}

const HIGH_WATER_MARK = 10 * 1024 * 1024;
const REVERSE_STRIPE_BYTES = 10 * 1024 * 1024;

// ── Shared read core ──────────────────────────────────────────────────────────
// Direction-agnostic helpers used by both the forward BlockBuffer.read() and the
// reverse ReverseBlockReader.read(). The reverse path is structurally identical to
// forward: its ReverseReadable emits the file's bytes with frames pre-reversed, so
// the same deinterleave produces reverse-time-order output.

// Interleaved (frame * channels + ch) float32 bytes → per-channel planar Float32Arrays.
function deinterleave(buf: Buffer, channels: number): Array<Float32Array> {
	const bytesPerFrame = channels * 4;
	const frames = Math.floor(buf.length / bytesPerFrame);
	const interleaved = new Float32Array(buf.buffer, buf.byteOffset, frames * channels);
	const out: Array<Float32Array> = [];

	for (let ch = 0; ch < channels; ch++) out.push(new Float32Array(frames));

	for (let frame = 0; frame < frames; frame++) {
		const base = frame * channels;

		for (let ch = 0; ch < channels; ch++) {
			out[ch]![frame] = interleaved[base + ch]!;
		}
	}

	return out;
}

function buildBlock(samples: Array<Float32Array>, offset: number, sampleRate?: number, bitDepth?: number): Block {
	return { samples, offset, sampleRate: sampleRate ?? 0, bitDepth: bitDepth ?? 0 };
}

// Serve exactly `bytesNeeded` bytes from a Readable by draining rs.read() and unshifting the
// remainder — the re-chunker that guarantees read(n) cadence regardless of the stream's internal
// chunking. It NEVER throws on stream failure: the wait race wakes on 'readable'/'end'/'error'/'close'
// (all four merely wake the loop, which re-checks rs.read() then isEnded()), and a failed stream is
// reported by isEnded() returning true, so the loop terminates and a short (possibly empty) buffer is
// returned. Error POLICY lives in the caller: forward swallows a short return (short == end-of-data);
// the reverse reader throws on it (short == truncation/failure, since the file length is known at open).
async function pullBytes(rs: Readable, isEnded: () => boolean, bytesNeeded: number): Promise<Buffer> {
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

		if (isEnded()) break;

		await new Promise<void>((resolve) => {
			const wake = (): void => {
				rs.off("readable", wake);
				rs.off("end", wake);
				rs.off("error", wake);
				rs.off("close", wake);
				resolve();
			};

			rs.once("readable", wake);
			rs.once("end", wake);
			rs.once("error", wake);
			rs.once("close", wake);
		});
	}

	if (chunks.length === 0) return Buffer.alloc(0);
	if (chunks.length === 1) return chunks[0]!;

	return Buffer.concat(chunks);
}

// Windows-EBUSY discipline: the file descriptor isn't released until 'close' fires — without awaiting
// it, a subsequent unlink() can race the stream's tear-down and fail with EBUSY. Shared by the forward
// read stream teardown and the reverse reader's close().
async function awaitStreamClose(stream: ReadStream | Readable): Promise<void> {
	if (stream.closed) return;

	await new Promise<void>((resolve) => {
		stream.once("close", () => resolve());
	});
}

// `reset()` overwrites the file in place without truncating — bytes past the new write region persist until overwritten.
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
	// ReverseBlockReader class comment for the full borrow contract.
	async openReverseReader(): Promise<ReverseBlockReader> {
		await this.flushWrites();

		const reader = new ReverseBlockReader(
			this.tempPath,
			{ frames: this._frames, channels: this._channels, sampleRate: this._sampleRate, bitDepth: this._bitDepth },
			REVERSE_STRIPE_BYTES,
			this,
		);

		this.reverseReaders.add(reader);

		return reader;
	}

	// Called by a factory-created reader from its close() so it deregisters itself. Idempotent.
	deregisterReverseReader(reader: ReverseBlockReader): void {
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

	async read(frames: number): Promise<Block> {
		const channels = this._channels;
		const startFrame = this.framesReadInSession;

		if (channels === 0 || frames <= 0 || this._frames === 0) {
			return buildBlock([], startFrame, this._sampleRate, this._bitDepth);
		}

		const bytesPerFrame = channels * 4;
		const rs = this.ensureReadStream();
		const buf = await pullBytes(rs, () => rs.destroyed || this.readStreamEnded, frames * bytesPerFrame);
		const actualFrames = Math.floor(buf.length / bytesPerFrame);

		if (actualFrames <= 0) return buildBlock([], startFrame, this._sampleRate, this._bitDepth);

		this.framesReadInSession += actualFrames;

		const out = deinterleave(buf, channels);

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

		// On Windows the file descriptor isn't released until 'close' fires — awaitStreamClose blocks a
		// subsequent unlink() (in clear/close) from racing the stream's tear-down and failing with EBUSY.
		await awaitStreamClose(rs);
	}
}

// A read-only reverse view over a source BlockBuffer's temp file. It BORROWS, it does not OWN: it holds
// its own FileHandle (inside a ReverseReadable), never unlinks the file, and never mutates the source
// buffer. Its validity ends at the next write/reset/clear/close on the source — the snapshot of
// frames/channels captured at open no longer describes the file after those operations. There is no
// invalidation machinery: both call sites open the reader, drain it to start-of-file, and close it with
// no interleaved writes on the source, so the borrow window is unambiguous. The source registers the
// reader (when created via openReverseReader) and closes it in clear()/close() before unlinking, because
// on Windows an open handle blocks unlink with EBUSY — the same discipline the forward read stream
// applies in endReadStream.
//
// The read cursor starts at `frames` and walks toward 0. read(n) serves min(n, remaining) frames covering
// source-frame window [cursor - m, cursor) returned in REVERSE time order (output frame 0 = source frame
// cursor - 1, …), then advances the cursor toward 0. At cursor 0 read returns an empty chunk.
//
// Internally this rides the SAME stream-buffer caching philosophy as the forward path: a ReverseReadable
// (a module-internal Readable) emits the file's bytes with frames pre-reversed, Node's stream buffer
// (highWaterMark = windowBytes) is the cache, and pullBytes + deinterleave + buildBlock re-chunk
// and reconstruct planar samples exactly as forward. The reversal is irreducible (Node has no backward createReadStream);
// pushing it to the produce side makes everything downstream direction-agnostic.
export class ReverseBlockReader {
	readonly frames: number;
	readonly channels: number;

	private readonly path?: string;
	private readonly sampleRate?: number;
	private readonly bitDepth?: number;
	private readonly bytesPerFrame: number;
	private readonly windowBytes: number;
	private readonly parent?: BlockBuffer;

	private framesReturned = 0;
	private closed = false;

	private stream?: ReverseReadable;
	private streamError?: Error;

	constructor(
		path: string | undefined,
		meta: { frames: number; channels: number; sampleRate?: number; bitDepth?: number },
		stripeBytes = REVERSE_STRIPE_BYTES,
		parent?: BlockBuffer,
	) {
		// A never-written source has no temp file: zero frames, every read is empty, close() is a no-op,
		// and no ReverseReadable is ever constructed.
		this.path = path;
		this.frames = path === undefined ? 0 : meta.frames;
		this.channels = meta.channels;
		this.sampleRate = meta.sampleRate;
		this.bitDepth = meta.bitDepth;
		this.bytesPerFrame = meta.channels * 4;
		// Frame-align the window (a whole multiple of bytesPerFrame, at least one frame) so every emitted
		// backward window contains whole frames — the same alignment the prior stripe cache computed.
		this.windowBytes =
			meta.channels === 0 ? stripeBytes : Math.max(this.bytesPerFrame, Math.floor(stripeBytes / this.bytesPerFrame) * this.bytesPerFrame);
		this.parent = parent;
	}

	async read(frames: number): Promise<Block> {
		if (this.closed) {
			throw new Error("ReverseBlockReader: read() after close()");
		}

		const offset = this.framesReturned;
		const remaining = this.frames - this.framesReturned;

		if (this.path === undefined || this.channels === 0 || frames <= 0 || remaining <= 0) {
			return buildBlock([], offset, this.sampleRate, this.bitDepth);
		}

		// Clamp to frames remaining, so in healthy operation pullBytes is never short. A short return
		// therefore means the stream ended early (truncated file / error / external destroy) — a real
		// failure, because the file length is known at open. Reverse-time order is already produced by
		// ReverseReadable (bytes arrive frame-reversed); the same deinterleave used forward applies.
		const count = Math.min(frames, remaining);
		const rs = this.ensureStream();
		const buf = await pullBytes(rs, () => rs.destroyed || rs.readableEnded, count * this.bytesPerFrame);
		const actualFrames = Math.floor(buf.length / this.bytesPerFrame);

		if (actualFrames < count) {
			// Short read: the stream failed or truncated. Surface the captured error (or a generic one).
			throw this.streamError ?? new Error("ReverseBlockReader: unexpected end of reverse stream");
		}

		this.framesReturned += actualFrames;

		const out = deinterleave(buf, this.channels);

		return buildBlock(out, offset, this.sampleRate, this.bitDepth);
	}

	async *iterate(frames: number): AsyncIterableIterator<Block> {
		for (;;) {
			const block = await this.read(frames);

			if ((block.samples[0]?.length ?? 0) === 0) return;

			yield block;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;

		this.closed = true;

		const stream = this.stream;

		this.stream = undefined;

		if (stream) {
			stream.destroy();
			await awaitStreamClose(stream);
		}

		this.parent?.deregisterReverseReader(this);
	}

	private ensureStream(): ReverseReadable {
		if (this.stream) return this.stream;
		if (this.path === undefined) {
			throw new Error("ReverseBlockReader: no source file");
		}

		const totalBytes = this.frames * this.bytesPerFrame;
		const stream = new ReverseReadable(this.path, totalBytes, this.bytesPerFrame, this.windowBytes);

		// An unlistened 'error' event crashes the process; capture it so read() can surface it after a
		// short pullBytes return.
		stream.once("error", (error: Error) => {
			this.streamError = error;
		});

		this.stream = stream;

		return stream;
	}
}

// A module-internal (NOT exported) Readable that wraps a FileHandle and emits the temp file's contents as
// an ordinary forward byte stream whose frames happen to be ordered last-to-first. This moves the reversal
// to the produce side so everything downstream (pullBytes, deinterleave, buildBlock) is
// direction-agnostic and shared with the forward path. Backpressure is free: _read is only called when the
// stream's internal buffer (highWaterMark = windowBytes) drains, so that buffer replaces the old
// hand-rolled stripe cache one-for-one.
class ReverseReadable extends Readable {
	private readonly path: string;
	private readonly bytesPerFrame: number;
	private readonly windowBytes: number;
	private pos: number;

	private handle?: FileHandle;

	constructor(path: string, totalBytes: number, bytesPerFrame: number, windowBytes: number) {
		super({ highWaterMark: windowBytes });

		this.path = path;
		this.bytesPerFrame = bytesPerFrame;
		this.windowBytes = windowBytes;
		this.pos = totalBytes;
	}

	// Emits the next backward window [max(0, pos - windowBytes), pos), with the frame order reversed in
	// place (channel order INSIDE each frame preserved — interleaved layout intact), then walks pos toward
	// 0 and pushes null at start-of-file. Node does not consume a rejected _read promise — an uncaught
	// throw becomes an unhandled rejection and the stream never errors — so any failure is routed to
	// destroy(err), which fires the 'error'/'close' events pullBytes waits on.
	override _read(): void {
		void this.readWindow();
	}

	private async readWindow(): Promise<void> {
		try {
			if (this.pos <= 0) {
				this.push(null);

				return;
			}

			const startByte = Math.max(0, this.pos - this.windowBytes);
			const length = this.pos - startByte;
			const buf = Buffer.alloc(length);

			await this.readFully(buf, startByte);

			this.reverseFramesInPlace(buf);
			this.pos = startByte;

			this.push(buf);
		} catch (error) {
			this.destroy(error as Error);
		}
	}

	// Reverse the frame order within the window in place: frame i swaps with frame (frameCount - 1 - i),
	// each frame being one bytesPerFrame-wide slice. Channel order inside a frame is untouched, so the
	// interleaved layout survives — only the time order flips.
	private reverseFramesInPlace(buf: Buffer): void {
		const frameCount = Math.floor(buf.length / this.bytesPerFrame);
		const scratch = Buffer.alloc(this.bytesPerFrame);

		for (let low = 0, high = frameCount - 1; low < high; low++, high--) {
			const lowByte = low * this.bytesPerFrame;
			const highByte = high * this.bytesPerFrame;

			buf.copy(scratch, 0, lowByte, lowByte + this.bytesPerFrame);
			buf.copy(buf, lowByte, highByte, highByte + this.bytesPerFrame);
			scratch.copy(buf, highByte, 0, this.bytesPerFrame);
		}
	}

	// The one centralized positioned read-fully helper. Loops on handle.read and throws on a zero-byte
	// read (unexpected EOF) — the shared guard against the former unchecked-bytesRead short-read bug.
	private async readFully(target: Buffer, position: number): Promise<void> {
		const handle = await this.ensureHandle();
		let filled = 0;

		while (filled < target.length) {
			const { bytesRead } = await handle.read(target, filled, target.length - filled, position + filled);

			if (bytesRead === 0) {
				throw new Error(`ReverseReadable: unexpected EOF at byte ${position + filled}`);
			}

			filled += bytesRead;
		}
	}

	private async ensureHandle(): Promise<FileHandle> {
		if (this.handle) return this.handle;

		this.handle = await open(this.path, "r");

		return this.handle;
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		const handle = this.handle;

		this.handle = undefined;

		if (!handle) {
			callback(error);

			return;
		}

		// The EBUSY close discipline lives in the stream's own lifecycle: close the FileHandle (awaited),
		// then signal completion. Preserve the destroy error.
		handle
			.close()
			.then(() => callback(error))
			.catch((closeError: unknown) => callback(error ?? (closeError as Error)));
	}
}
