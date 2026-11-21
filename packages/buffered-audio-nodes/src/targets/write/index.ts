import { lstat, open, stat, truncate, unlink, type FileHandle } from "node:fs/promises";
import { sep } from "node:path";
import {
	BufferedTargetStream,
	childFailure,
	releaseChild,
	spawnChild,
	TargetNode,
	terminateChild,
	writeChildInput,
	type Block,
	type ChildHandle,
	type StreamSetupContext,
	type TargetNodeProperties,
} from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createFfmpegPathField } from "../../utils/binary-fields";
import { getBytesPerSample, writeSample, buildWavHeader, buildRf64Header } from "./utils/wav";
import type { BigIntStats } from "node:fs";

function bitDepthToPcmFormat(bitDepth: WavBitDepth): string {
	switch (bitDepth) {
		case "16":
			return "s16le";
		case "24":
			return "s24le";
		case "32":
			return "s32le";
		case "32f":
			return "f32le";
	}
}

export type WavBitDepth = "16" | "24" | "32" | "32f";

export interface EncodingOptions {
	readonly format: "wav" | "flac" | "mp3" | "aac";
	readonly bitrate?: number;
	readonly vbr?: number;
	readonly sampleRate?: number;
}

export const encodingSchema = z.object({
	format: z.enum(["wav", "flac", "mp3", "aac"]),
	bitrate: z
		.number()
		.int()
		.min(8)
		.max(1024)
		.optional()
		.describe("Constant bitrate in kbps for MP3 and AAC. Defaults to 192 kbps."),
	vbr: z.number().min(0).max(9).optional(),
	sampleRate: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Output sample rate (Hz). When set, ffmpeg resamples on encode."),
});

const schema = z.object({
	path: z.string().default("").meta({ input: "file", mode: "save", accept: ".wav,.flac,.mp3,.aac" }),
	ffmpegPath: createFfmpegPathField(),
	bitDepth: z.enum(["16", "24", "32", "32f"]).default("16"),
	encoding: encodingSchema.optional().describe("Encode through ffmpeg to a non-WAV format. Requires `ffmpegPath`."),
});

export interface WriteProperties extends TargetNodeProperties {
	readonly path: string;
	readonly ffmpegPath?: string;
	readonly bitDepth: WavBitDepth;
	readonly encoding?: EncodingOptions;
}

const WAV_HEADER_SIZE = 80;
const UINT32_MAX = 0xffffffff;

async function writeFully(fileHandle: FileHandle, bytes: Buffer, position: number): Promise<void> {
	let done = 0;

	while (done < bytes.length) {
		const { bytesWritten } = await fileHandle.write(bytes, done, bytes.length - done, position + done);

		if (bytesWritten === 0) throw new Error(`Write wrote no bytes at offset ${String(position + done)}`);

		done += bytesWritten;
	}
}

function endsWithSeparator(path: string): boolean {
	return path.endsWith("/") || path.endsWith(sep);
}

function ignoreMissing(error: unknown): undefined {
	const code = (error as NodeJS.ErrnoException).code;

	if (code === "ENOENT" || code === "ENOTDIR") return undefined;

	throw error;
}

async function isDirectory(path: string): Promise<boolean> {
	return stat(path).then(
		(stats) => stats.isDirectory(),
		() => false,
	);
}

async function fileIdentity(path: string): Promise<BigIntStats | undefined> {
	return stat(path, { bigint: true }).catch(() => undefined);
}

function isSameFile(before: BigIntStats, after: BigIntStats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs
	);
}

async function emptyOutput(path: string, removalError: unknown): Promise<void> {
	await truncate(path, 0).catch(() => {
		throw removalError;
	});
}

async function removeOutput(path: string): Promise<void> {
	const entry = await lstat(path).catch(ignoreMissing);

	if (entry?.isFile()) {
		await unlink(path).catch(async (error: unknown) => emptyOutput(path, error));
	} else if (entry?.isSymbolicLink() && (await stat(path).catch(ignoreMissing))?.isFile()) {
		await truncate(path, 0);
	}
}

export class WriteStream extends BufferedTargetStream<WriteNode> {
	private fileHandle?: FileHandle;
	private handle?: ChildHandle;
	private closed = false;
	private touched = false;
	private existingTarget?: BigIntStats;
	private sampleRate = 0;
	private channels = 0;
	private bytesWritten = 0;
	private useEncoding = false;
	private initialized = false;

	override async _setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> {
		const path = this.properties.path;

		if (path === "") throw new Error("Write needs a file path; path is empty");

		if (endsWithSeparator(path)) throw new Error(`Write needs a file path; "${path}" ends with a path separator`);

		this.bytesWritten = 0;
		this.initialized = false;
		this.closed = false;
		this.touched = false;
		this.existingTarget = undefined;

		const encoding = this.properties.encoding;

		if (encoding && encoding.format !== "wav" && !this.properties.ffmpegPath) {
			throw new Error(`Encoding to ${encoding.format} requires ffmpegPath`);
		}

		this.useEncoding = encoding !== undefined && encoding.format !== "wav" && !!this.properties.ffmpegPath;

		if (this.useEncoding) {
			if (await isDirectory(path)) throw new Error(`Write needs a file path; "${path}" is a directory`);
		} else {
			this.fileHandle = await open(path, "w");
			this.touched = true;
		}

		return super._setup(input, context);
	}

	private async initialize(chunk: Block): Promise<void> {
		if (this.initialized) return;

		this.initialized = true;

		this.sampleRate = chunk.sampleRate;
		this.channels = chunk.samples.length;

		if (this.useEncoding) {
			await this.spawnFfmpeg();
		} else if (this.fileHandle) {
			const header = buildWavHeader(0, this.sampleRate, this.channels, this.properties.bitDepth);

			await writeFully(this.fileHandle, header, 0);
		}
	}

	private async spawnFfmpeg(): Promise<void> {
		const encoding = this.properties.encoding;
		const ffmpegPath = this.properties.ffmpegPath;

		if (!encoding || !ffmpegPath) throw new Error("ffmpeg encoding misconfigured");

		this.existingTarget = await fileIdentity(this.properties.path);
		this.handle = spawnChild({
			label: "ffmpeg",
			command: ffmpegPath,
			args: this.buildFfmpegArgs(encoding),
			stdout: "ignore",
		});
		this.touched = this.handle.child.pid !== undefined;
	}

	override async _write(chunk: Block): Promise<void> {
		await this.initialize(chunk);

		const bytes = this.convertChunk(chunk);

		if (this.useEncoding && this.handle) {
			await writeChildInput(this.handle, bytes, this.streamSignal);
		} else if (this.fileHandle) {
			await writeFully(this.fileHandle, bytes, WAV_HEADER_SIZE + this.bytesWritten);
		}

		this.bytesWritten += bytes.length;
	}

	override async _close(): Promise<void> {
		if (this.useEncoding) {
			if (this.handle) await this.finishEncoder(this.handle);
		} else if (this.fileHandle) {
			const header =
				this.bytesWritten > UINT32_MAX
					? buildRf64Header(this.bytesWritten, this.sampleRate, this.channels, this.properties.bitDepth)
					: buildWavHeader(this.bytesWritten, this.sampleRate, this.channels, this.properties.bitDepth);

			await writeFully(this.fileHandle, header, 0);
			await this.fileHandle.close();
			this.fileHandle = undefined;
		}

		this.closed = true;
	}

	override async _destroy(): Promise<void> {
		const handle = this.handle;

		this.handle = undefined;

		if (handle) {
			await terminateChild(handle.child, this.closed ? undefined : { firstSignal: "SIGKILL" });
			releaseChild(handle);
		}

		if (this.fileHandle) {
			await this.fileHandle.close().catch(() => undefined);
			this.fileHandle = undefined;
		}

		if (!this.closed && this.touched) await this.removeUnfinishedOutput();
	}

	private async removeUnfinishedOutput(): Promise<void> {
		const path = this.properties.path;
		const existing = this.existingTarget;

		if (existing) {
			const current = await fileIdentity(path);

			if (current && isSameFile(existing, current)) return;
		}

		await removeOutput(path);
	}

	private async finishEncoder(handle: ChildHandle): Promise<void> {
		const signal = this.streamSignal;

		handle.stdin?.end();

		const failure = await childFailure(handle, { signal });

		signal.throwIfAborted();

		if (failure) throw failure;

		const stdinError = handle.stdinError();

		if (stdinError) throw stdinError;
	}

	private convertChunk(chunk: Block): Buffer {
		const frames = chunk.samples[0]?.length ?? 0;
		const channels = chunk.samples.length;
		const bytesPerSample = getBytesPerSample(this.properties.bitDepth);
		const buffer = Buffer.alloc(frames * channels * bytesPerSample);

		let offset = 0;

		for (let frame = 0; frame < frames; frame++) {
			for (let channel = 0; channel < channels; channel++) {
				const sample = chunk.samples[channel]?.[frame] ?? 0;

				offset = writeSample(buffer, offset, sample, this.properties.bitDepth);
			}
		}

		return buffer;
	}

	private buildFfmpegArgs(encoding: EncodingOptions): Array<string> {
		const pcmFormat = bitDepthToPcmFormat(this.properties.bitDepth);
		const args = [
			"-hide_banner",
			"-nostats",
			"-loglevel",
			"error",
			"-f",
			pcmFormat,
			"-ar",
			String(this.sampleRate),
			"-ac",
			String(this.channels),
			"-i",
			"pipe:0",
		];

		switch (encoding.format) {
			case "flac":
				args.push("-codec:a", "flac");

				break;
			case "mp3":
				args.push("-codec:a", "libmp3lame");

				if (encoding.vbr !== undefined) {
					args.push("-q:a", String(encoding.vbr));
				} else {
					args.push("-b:a", `${encoding.bitrate ?? 192}k`);
				}

				break;
			case "aac":
				args.push("-codec:a", "aac", "-b:a", `${encoding.bitrate ?? 192}k`);

				break;
		}

		if (encoding.sampleRate !== undefined) {
			args.push("-ar", String(encoding.sampleRate));
		}

		args.push("-y", this.properties.path);

		return args;
	}
}

export class WriteNode extends TargetNode<WriteProperties> {
	static override readonly nodeName = "Write";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Write audio to a file";
	static override readonly schema = schema;
	static override readonly Stream = WriteStream;
}

export function write(
	path: string,
	options?: { bitDepth?: WavBitDepth; ffmpegPath?: string; encoding?: EncodingOptions },
): WriteNode {
	return new WriteNode({ path, ...options });
}
