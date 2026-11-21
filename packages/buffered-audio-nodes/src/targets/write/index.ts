import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	access,
	chmod,
	constants,
	lstat,
	open,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
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
import type { Stats } from "node:fs";

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

function partialPath(path: string): string {
	const { dir, name, ext } = parse(path);

	return join(dir, `${name}.partial-${process.pid}-${randomBytes(4).toString("hex")}${ext}`);
}

function endsWithSeparator(path: string): boolean {
	return path.endsWith("/") || path.endsWith(sep);
}

const WINDOWS_DEVICE_NAME = /^(?:NUL|CON|PRN|AUX|COM[1-9]|LPT[1-9])$/i;

function windowsDevicePath(path: string): string | undefined {
	if (process.platform !== "win32") return undefined;

	if (path.startsWith("\\\\.\\") || path.startsWith("//./")) return path;

	const name = basename(path);

	return WINDOWS_DEVICE_NAME.test(name) ? `\\\\.\\${name.toUpperCase()}` : undefined;
}

async function statTarget(path: string): Promise<Stats | undefined> {
	try {
		return await stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;

		throw error;
	}
}

const MAX_SYMLINK_HOPS = 40;

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

async function danglingSymlinkTarget(path: string): Promise<string | undefined> {
	let current = path;

	for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
		const stats = await lstat(current).catch((error: unknown) => {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;

			throw error;
		});

		if (!stats?.isSymbolicLink()) return hop === 0 ? undefined : current;

		current = resolve(dirname(current), await readlink(current));
	}

	throw Object.assign(new Error(`ELOOP: too many symbolic links encountered, open '${path}'`), {
		code: "ELOOP",
		syscall: "open",
		path,
	});
}

async function resolveDestination(path: string, target: Stats | undefined): Promise<string> {
	if (target) return (await lstat(path)).isSymbolicLink() ? realpath(path) : path;

	const named = (await danglingSymlinkTarget(path)) ?? path;

	try {
		return join(await realpath(dirname(named)), basename(named));
	} catch {
		return named;
	}
}

async function assertFolderExists(path: string, destination: string): Promise<void> {
	try {
		await stat(dirname(destination));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;

		throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
			code: "ENOENT",
			syscall: "open",
			path,
		});
	}
}

async function copyModeOfTarget(temporaryPath: string, path: string): Promise<void> {
	if (process.platform === "win32") return;

	const target = await statTarget(path);

	if (target?.isFile()) await chmod(temporaryPath, target.mode & 0o7777);
}

const RENAME_RETRY_MS = 1000;
const RENAME_BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function isRetryableRename(error: unknown, to: string, deadline: number): Promise<boolean> {
	const code = (error as NodeJS.ErrnoException).code ?? "";

	if (process.platform !== "win32" || !RENAME_BUSY_CODES.has(code) || performance.now() > deadline) return false;

	const target = await statTarget(to).catch(() => undefined);

	return !target?.isDirectory();
}

function needsCopy(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;

	return code === "EXDEV" || (code === "EBUSY" && process.platform !== "win32");
}

async function renameOnto(from: string, to: string, signal: AbortSignal): Promise<void> {
	const deadline = performance.now() + RENAME_RETRY_MS;

	for (;;) {
		signal.throwIfAborted();

		try {
			await rename(from, to);

			return;
		} catch (error) {
			if (needsCopy(error)) {
				await pipeline(createReadStream(from), createWriteStream(to));
				await rm(from, { force: true });

				return;
			}

			if (!(await isRetryableRename(error, to, deadline))) throw error;

			signal.throwIfAborted();

			await delay(20, undefined, { signal }).catch(() => undefined);
		}
	}
}

export class WriteStream extends BufferedTargetStream<WriteNode> {
	private fileHandle?: FileHandle;
	private handle?: ChildHandle;
	private closed = false;
	private temporaryPath?: string;
	private destination?: string;
	private sampleRate = 0;
	private channels = 0;
	private bytesWritten = 0;
	private useEncoding = false;
	private initialized = false;

	override async _setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> {
		const path = this.properties.path;

		if (path === "") throw new Error("Write needs a file path; path is empty");

		if (endsWithSeparator(path)) throw new Error(`Write needs a file path; "${path}" ends with a path separator`);

		const device = windowsDevicePath(path);
		const target = device === undefined ? await statTarget(path) : undefined;

		if (target?.isDirectory()) throw new Error(`Write needs a file path; "${path}" is a directory`);

		this.bytesWritten = 0;
		this.initialized = false;
		this.closed = false;

		const encoding = this.properties.encoding;

		if (encoding && encoding.format !== "wav" && !this.properties.ffmpegPath) {
			throw new Error(`Encoding to ${encoding.format} requires ffmpegPath`);
		}

		this.useEncoding = encoding !== undefined && encoding.format !== "wav" && !!this.properties.ffmpegPath;

		this.destination =
			device !== undefined || (target && !target.isFile()) ? undefined : await resolveDestination(path, target);

		if (target && this.destination !== undefined) await access(this.destination, constants.W_OK);

		if (!target && this.destination !== undefined) await assertFolderExists(path, this.destination);

		this.temporaryPath = this.destination === undefined ? undefined : partialPath(this.destination);

		if (!this.useEncoding) this.fileHandle = await open(this.temporaryPath ?? device ?? path, "w");

		return super._setup(input, context);
	}

	private async initialize(chunk: Block): Promise<void> {
		if (this.initialized) return;

		this.initialized = true;

		this.sampleRate = chunk.sampleRate;
		this.channels = chunk.samples.length;

		if (this.useEncoding) {
			this.spawnFfmpeg();
		} else if (this.fileHandle) {
			const header = buildWavHeader(0, this.sampleRate, this.channels, this.properties.bitDepth);

			await writeFully(this.fileHandle, header, 0);
		}
	}

	private spawnFfmpeg(): void {
		const encoding = this.properties.encoding;
		const ffmpegPath = this.properties.ffmpegPath;

		if (!encoding || !ffmpegPath) throw new Error("ffmpeg encoding misconfigured");

		this.handle = spawnChild({
			label: "ffmpeg",
			command: ffmpegPath,
			args: this.buildFfmpegArgs(encoding, this.temporaryPath ?? this.properties.path),
			stdout: "ignore",
		});
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
			if (!this.handle) {
				this.closed = true;

				return;
			}

			await this.finishEncoder(this.handle);
		} else if (this.fileHandle) {
			const header =
				this.bytesWritten > UINT32_MAX
					? buildRf64Header(this.bytesWritten, this.sampleRate, this.channels, this.properties.bitDepth)
					: buildWavHeader(this.bytesWritten, this.sampleRate, this.channels, this.properties.bitDepth);

			await writeFully(this.fileHandle, header, 0);
			await this.fileHandle.close();
			this.fileHandle = undefined;
		}

		if (this.temporaryPath && this.destination) await this.moveIntoPlace(this.temporaryPath, this.destination);

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

		if (!this.closed && this.temporaryPath) await rm(this.temporaryPath, { force: true });
	}

	private async finishEncoder(handle: ChildHandle): Promise<void> {
		const signal = this.streamSignal;

		handle.stdin?.end();

		const failure = await childFailure(handle, { signal });

		signal.throwIfAborted();

		if (failure) throw failure;

		const stdinError = handle.stdinError();

		if (stdinError) throw stdinError;

		const temporaryPath = this.temporaryPath;

		if (temporaryPath === undefined) return;

		const written = await access(temporaryPath).then(
			() => true,
			() => false,
		);

		if (!written) throw new Error(`ffmpeg exited 0 but wrote no output at "${temporaryPath}"`);
	}

	private async moveIntoPlace(temporaryPath: string, path: string): Promise<void> {
		const signal = this.streamSignal;

		try {
			await copyModeOfTarget(temporaryPath, path);
			await renameOnto(temporaryPath, path, signal);
		} catch (error) {
			await rm(temporaryPath, { force: true });

			if (signal.aborted && error === signal.reason) throw error;

			throw new Error(
				`Cannot move "${temporaryPath}" onto "${path}": ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
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

	private buildFfmpegArgs(encoding: EncodingOptions, outputPath: string): Array<string> {
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

		args.push("-y", outputPath);

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
