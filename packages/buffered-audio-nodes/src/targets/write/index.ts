import { access, open, rename, rm, type FileHandle } from "node:fs/promises";
import { join, parse } from "node:path";
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

function partialPath(path: string): string {
	const { dir, name, ext } = parse(path);

	return join(dir, `${name}.partial-${process.pid}${ext}`);
}

export class WriteStream extends BufferedTargetStream<WriteNode> {
	private fileHandle?: FileHandle;
	private handle?: ChildHandle;
	private closed = false;
	private temporaryPath?: string;
	private sampleRate = 0;
	private channels = 0;
	private bytesWritten = 0;
	private useEncoding = false;
	private initialized = false;

	override async _setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> {
		if (this.properties.path === "") throw new Error("Write needs a file path; path is empty");

		this.bytesWritten = 0;
		this.initialized = false;
		this.closed = false;

		const encoding = this.properties.encoding;

		if (encoding && encoding.format !== "wav" && !this.properties.ffmpegPath) {
			throw new Error(`Encoding to ${encoding.format} requires ffmpegPath`);
		}

		this.useEncoding = encoding !== undefined && encoding.format !== "wav" && !!this.properties.ffmpegPath;

		if (!this.useEncoding) {
			this.temporaryPath = partialPath(this.properties.path);
			this.fileHandle = await open(this.temporaryPath, "w");
		}

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

			await this.fileHandle.write(header, 0, WAV_HEADER_SIZE, 0);
		}
	}

	private spawnFfmpeg(): void {
		const encoding = this.properties.encoding;
		const ffmpegPath = this.properties.ffmpegPath;

		if (!encoding || !ffmpegPath) throw new Error("ffmpeg encoding misconfigured");

		const temporaryPath = partialPath(this.properties.path);

		this.temporaryPath = temporaryPath;
		this.handle = spawnChild({
			label: "ffmpeg",
			command: ffmpegPath,
			args: this.buildFfmpegArgs(encoding, temporaryPath),
			stdout: "ignore",
		});
	}

	override async _write(chunk: Block): Promise<void> {
		await this.initialize(chunk);

		const bytes = this.convertChunk(chunk);

		if (this.useEncoding && this.handle) {
			await writeChildInput(this.handle, bytes, this.streamSignal);
		} else if (this.fileHandle) {
			await this.fileHandle.write(bytes, 0, bytes.length, WAV_HEADER_SIZE + this.bytesWritten);
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

			await this.fileHandle.write(header, 0, WAV_HEADER_SIZE, 0);
			await this.fileHandle.close();
			this.fileHandle = undefined;
		}

		if (this.temporaryPath) await this.moveIntoPlace(this.temporaryPath);

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

		const temporaryPath = this.temporaryPath ?? "";
		const written = await access(temporaryPath).then(
			() => true,
			() => false,
		);

		if (!written) throw new Error(`ffmpeg exited 0 but wrote no output at "${temporaryPath}"`);
	}

	private async moveIntoPlace(temporaryPath: string): Promise<void> {
		const path = this.properties.path;

		try {
			await rename(temporaryPath, path);
		} catch (error) {
			await rm(temporaryPath, { force: true });

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
