import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Block } from "../../block";
import { awaitStreamClose } from "./await-stream-close";
import type { BlockBuffer } from "./block-buffer";
import { buildBlock, deinterleave, pullBytes } from "./block-io";

const REVERSE_STRIPE_BYTES = 10 * 1024 * 1024;

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
		metadata: { frames: number; channels: number; sampleRate?: number; bitDepth?: number },
		stripeBytes = REVERSE_STRIPE_BYTES,
		parent?: BlockBuffer,
	) {
		this.path = path;
		this.frames = path === undefined ? 0 : metadata.frames;
		this.channels = metadata.channels;
		this.sampleRate = metadata.sampleRate;
		this.bitDepth = metadata.bitDepth;
		this.bytesPerFrame = metadata.channels * 4;
		this.windowBytes = metadata.channels === 0 ? stripeBytes : Math.max(this.bytesPerFrame, Math.floor(stripeBytes / this.bytesPerFrame) * this.bytesPerFrame);
		this.parent = parent;
	}

	async read(frames: number): Promise<Block> {
		if (this.closed) throw new Error("ReverseBlockReader: read() after close()");

		const offset = this.framesReturned;
		const remaining = this.frames - this.framesReturned;

		if (this.path === undefined || this.channels === 0 || frames <= 0 || remaining <= 0) {
			return buildBlock([], offset, this.sampleRate, this.bitDepth);
		}

		const count = Math.min(frames, remaining);
		const stream = this.ensureStream();
		const buffer = await pullBytes(stream, () => stream.destroyed || stream.readableEnded, count * this.bytesPerFrame);
		const actualFrames = Math.floor(buffer.length / this.bytesPerFrame);

		if (actualFrames < count) throw this.streamError ?? new Error("ReverseBlockReader: unexpected end of reverse stream");

		this.framesReturned += actualFrames;

		return buildBlock(deinterleave(buffer, this.channels), offset, this.sampleRate, this.bitDepth);
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
		if (this.path === undefined) throw new Error("ReverseBlockReader: no source file");

		const totalBytes = this.frames * this.bytesPerFrame;
		const stream = new ReverseReadable(this.path, totalBytes, this.bytesPerFrame, this.windowBytes);

		// Node crashes on an unhandled stream error; retain it so read can surface the original failure.
		stream.once("error", (error: Error) => {
			this.streamError = error;
		});

		this.stream = stream;

		return stream;
	}
}

class ReverseReadable extends Readable {
	private readonly path: string;
	private readonly bytesPerFrame: number;
	private readonly windowBytes: number;
	private position: number;
	private handlePromise?: Promise<FileHandle>;

	constructor(path: string, totalBytes: number, bytesPerFrame: number, windowBytes: number) {
		super({ highWaterMark: windowBytes });

		this.path = path;
		this.bytesPerFrame = bytesPerFrame;
		this.windowBytes = windowBytes;
		this.position = totalBytes;
	}

	override _read(): void {
		// Node does not observe a promise returned by _read, so failures must enter the stream via destroy.
		void this.readWindow();
	}

	private async readWindow(): Promise<void> {
		try {
			if (this.position <= 0) {
				this.push(null);

				return;
			}

			const startByte = Math.max(0, this.position - this.windowBytes);
			const length = this.position - startByte;
			const buffer = Buffer.alloc(length);

			await this.readFully(buffer, startByte);

			this.reverseFramesInPlace(buffer);
			this.position = startByte;
			this.push(buffer);
		} catch (error) {
			this.destroy(error as Error);
		}
	}

	private reverseFramesInPlace(buffer: Buffer): void {
		const frameCount = Math.floor(buffer.length / this.bytesPerFrame);
		const scratch = Buffer.alloc(this.bytesPerFrame);

		for (let low = 0, high = frameCount - 1; low < high; low++, high--) {
			const lowByte = low * this.bytesPerFrame;
			const highByte = high * this.bytesPerFrame;

			buffer.copy(scratch, 0, lowByte, lowByte + this.bytesPerFrame);
			buffer.copy(buffer, lowByte, highByte, highByte + this.bytesPerFrame);
			scratch.copy(buffer, highByte, 0, this.bytesPerFrame);
		}
	}

	private async readFully(target: Buffer, position: number): Promise<void> {
		const handle = await this.ensureHandle();
		let filled = 0;

		while (filled < target.length) {
			const { bytesRead } = await handle.read(target, filled, target.length - filled, position + filled);

			if (bytesRead === 0) throw new Error(`ReverseReadable: unexpected EOF at byte ${position + filled}`);

			filled += bytesRead;
		}
	}

	private ensureHandle(): Promise<FileHandle> {
		this.handlePromise ??= open(this.path, "r");

		return this.handlePromise;
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		const handlePromise = this.handlePromise;

		this.handlePromise = undefined;

		if (!handlePromise) {
			callback(error);

			return;
		}

		void handlePromise
			.then((handle) => handle.close())
			.then(
				() => callback(error),
				(closeError: unknown) => callback(error ?? (closeError instanceof Error ? closeError : new Error(String(closeError)))),
			);
	}
}
