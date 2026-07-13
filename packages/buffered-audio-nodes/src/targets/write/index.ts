import { spawn, type ChildProcess } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { BufferedTargetStream, TargetNode, type Block, type StreamSetupContext, type TargetNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME } from "../../package-metadata";
import { waitForDrain } from "../../utils/ffmpeg";
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
	readonly bitrate?: string;
	readonly vbr?: number;
	readonly sampleRate?: number;
}

export const encodingSchema = z.object({
	format: z.enum(["wav", "flac", "mp3", "aac"]),
	bitrate: z.string().optional(),
	vbr: z.number().min(0).max(9).optional(),
	sampleRate: z.number().int().positive().optional().describe("Output sample rate (Hz). When set, ffmpeg resamples on encode."),
});

export const schema = z.object({
	path: z.string().default("").meta({ input: "file", mode: "save", accept: ".wav,.flac,.mp3,.aac" }),
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
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

export class WriteStream extends BufferedTargetStream<WriteNode> {
	private fileHandle?: FileHandle;
	private ffmpegProcess?: ChildProcess;
	private ffmpegStdin?: NodeJS.WritableStream;
	private ffmpegDone?: Promise<void>;
	private sampleRate = 0;
	private channels = 0;
	private bytesWritten = 0;
	private useEncoding = false;
	private initialized = false;

	override async _setup(input: ReadableStream<Block>, context: StreamSetupContext): Promise<void> {
		this.bytesWritten = 0;
		this.initialized = false;

		const encoding = this.properties.encoding;

		if (encoding && encoding.format !== "wav" && !this.properties.ffmpegPath) {
			throw new Error(`Encoding to ${encoding.format} requires ffmpegPath`);
		}

		this.useEncoding = encoding !== undefined && encoding.format !== "wav" && !!this.properties.ffmpegPath;

		if (!this.useEncoding) {
			this.fileHandle = await open(this.properties.path, "w");
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

		const args = this.buildFfmpegArgs(encoding);

		const proc = spawn(ffmpegPath, args, {
			stdio: ["pipe", "ignore", "pipe"],
		});

		this.ffmpegProcess = proc;
		this.ffmpegStdin = proc.stdin;

		this.ffmpegStdin.on("error", () => {});

		this.ffmpegDone = new Promise<void>((resolve, reject) => {
			proc.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`ffmpeg exited with code ${code}`));
				} else {
					resolve();
				}
			});

			proc.on("error", (error) => {
				reject(new Error(`Failed to spawn ffmpeg: ${error.message}`));
			});
		});
	}

	override async _write(chunk: Block): Promise<void> {
		await this.initialize(chunk);

		const bytes = this.convertChunk(chunk);

		if (this.useEncoding && this.ffmpegStdin) {
			await this.writeToStdin(bytes);
		} else if (this.fileHandle) {
			await this.fileHandle.write(bytes, 0, bytes.length, WAV_HEADER_SIZE + this.bytesWritten);
		}

		this.bytesWritten += bytes.length;
	}

	override async _close(): Promise<void> {
		if (this.useEncoding) {
			if (this.ffmpegStdin) {
				this.ffmpegStdin.end();
			}

			if (this.ffmpegDone) {
				await this.ffmpegDone;
			}

			this.ffmpegProcess = undefined;
			this.ffmpegStdin = undefined;
			this.ffmpegDone = undefined;
		} else if (this.fileHandle) {
			const header =
				this.bytesWritten > UINT32_MAX
					? buildRf64Header(this.bytesWritten, this.sampleRate, this.channels, this.properties.bitDepth)
					: buildWavHeader(this.bytesWritten, this.sampleRate, this.channels, this.properties.bitDepth);

			await this.fileHandle.write(header, 0, WAV_HEADER_SIZE, 0);
			await this.fileHandle.close();
			this.fileHandle = undefined;
		}
	}

	override async _destroy(): Promise<void> {
		if (this.ffmpegProcess) {
			this.ffmpegProcess.kill();
			this.ffmpegProcess = undefined;
			this.ffmpegStdin = undefined;
			this.ffmpegDone = undefined;
		}

		if (this.fileHandle) {
			await this.fileHandle.close().catch(() => undefined);
			this.fileHandle = undefined;
		}
	}

	private convertChunk(chunk: Block): Buffer {
		const frames = chunk.samples[0]?.length ?? 0;
		const channels = chunk.samples.length;
		const bytesPerSample = getBytesPerSample(this.properties.bitDepth);
		const buffer = Buffer.alloc(frames * channels * bytesPerSample);

		let offset = 0;

		for (let frame = 0; frame < frames; frame++) {
			for (let ch = 0; ch < channels; ch++) {
				const sample = chunk.samples[ch]?.[frame] ?? 0;

				offset = writeSample(buffer, offset, sample, this.properties.bitDepth);
			}
		}

		return buffer;
	}

	private buildFfmpegArgs(encoding: EncodingOptions): Array<string> {
		const pcmFormat = bitDepthToPcmFormat(this.properties.bitDepth);
		const args = ["-f", pcmFormat, "-ar", String(this.sampleRate), "-ac", String(this.channels), "-i", "pipe:0"];

		switch (encoding.format) {
			case "flac":
				args.push("-codec:a", "flac");
				break;
			case "mp3":
				args.push("-codec:a", "libmp3lame");
				if (encoding.vbr !== undefined) {
					args.push("-q:a", String(encoding.vbr));
				} else {
					args.push("-b:a", encoding.bitrate ?? "192k");
				}

				break;
			case "aac":
				args.push("-codec:a", "aac", "-b:a", encoding.bitrate ?? "192k");
				break;
		}

		if (encoding.sampleRate !== undefined) {
			args.push("-ar", String(encoding.sampleRate));
		}

		args.push("-y", this.properties.path);

		return args;
	}

	private writeToStdin(data: Buffer): Promise<void> {
		const stdin = this.ffmpegStdin;
		const proc = this.ffmpegProcess;

		if (!stdin || !proc) return Promise.resolve();

		const canWrite = stdin.write(data);

		if (!canWrite) {
			return waitForDrain(proc, stdin);
		}

		return Promise.resolve();
	}
}

export class WriteNode extends TargetNode<WriteProperties> {
	static override readonly nodeName = "Write";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Write audio to a file";
	static override readonly schema = schema;
	static override readonly Stream = WriteStream;
}

export function write(path: string, options?: { bitDepth?: WavBitDepth; ffmpegPath?: string; encoding?: EncodingOptions }): WriteNode {
	return new WriteNode({ path, ...options });
}
