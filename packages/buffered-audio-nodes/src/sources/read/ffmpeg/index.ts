import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { BufferedSourceStream, SourceNode, type Block, type SourceMetadata, type SourceNodeProperties } from "@buffered-audio/core";
import { deinterleaveBuffer } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../../package-metadata";

export const ffmpegSchema = z.object({
	path: z.string().default("").meta({ input: "file", mode: "open" }),
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
	ffprobePath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "ffprobe", download: "https://ffmpeg.org/download.html" })
		.describe("FFprobe — media file analyzer (included with FFmpeg)"),
});

export interface ReadFfmpegProperties extends z.infer<typeof ffmpegSchema>, SourceNodeProperties {
	readonly channels?: ReadonlyArray<number>;
}

const DEFAULT_CHUNK_SIZE = 44100;

const TEARDOWN_KILL_GRACE_MS = 2000;

interface ProbeResult {
	readonly sampleRate: number;
	readonly channels: number;
	readonly duration: number;
}

export class ReadFfmpegStream<P extends ReadFfmpegProperties = ReadFfmpegProperties> extends BufferedSourceStream<P> {
	private ffmpegProcess?: ChildProcess;
	private stdout?: NodeJS.ReadableStream;
	private frameOffset = 0;
	private remainder?: Buffer;
	private outputChannels = 0;
	private sourceSampleRate = 0;
	private sourceBitDepth = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		const probe = await this.probe(this.properties.ffprobePath, this.properties.path);
		const selectedChannels = this.properties.channels;
		const channels = selectedChannels ? selectedChannels.length : probe.channels;

		return {
			sampleRate: probe.sampleRate,
			channels,
			durationFrames: Math.round(probe.duration * probe.sampleRate),
		};
	}

	private async ensureInitialized(): Promise<void> {
		if (this.ffmpegProcess) return;

		const probe = await this.probe(this.properties.ffprobePath, this.properties.path);
		const selectedChannels = this.properties.channels;

		this.outputChannels = selectedChannels ? selectedChannels.length : probe.channels;
		this.sourceSampleRate = probe.sampleRate;
		this.sourceBitDepth = 32;

		const args = ["-i", this.properties.path, "-f", "f32le", "-acodec", "pcm_f32le", "-ar", String(probe.sampleRate)];

		if (selectedChannels) {
			const panParts = selectedChannels.map((srcCh, outCh) => `c${outCh}=c${srcCh}`);
			const layout = this.outputChannels === 1 ? "mono" : `${this.outputChannels}c`;

			args.push("-af", `pan=${layout}|${panParts.join("|")}`);
			args.push("-ac", String(this.outputChannels));
		} else {
			args.push("-ac", String(probe.channels));
		}

		args.push("pipe:1");

		const proc = spawn(this.properties.ffmpegPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		this.ffmpegProcess = proc;
		this.stdout = proc.stdout;
		this.remainder = undefined;
		this.frameOffset = 0;

		proc.stderr.resume();
	}

	override async _read(): Promise<Block | undefined> {
		await this.ensureInitialized();

		const bytesPerFrame = this.outputChannels * 4;
		const targetBytes = DEFAULT_CHUNK_SIZE * bytesPerFrame;

		const data = await this.readBytes(targetBytes);

		if (!data || data.length === 0) {
			return undefined;
		}

		const usableBytes = Math.floor(data.length / bytesPerFrame) * bytesPerFrame;

		if (usableBytes === 0) {
			return undefined;
		}

		const leftover = data.length - usableBytes;

		if (leftover > 0) {
			this.remainder = Buffer.from(data.buffer, data.byteOffset + usableBytes, leftover);
		}

		const frames = usableBytes / bytesPerFrame;
		const sampleBuffer = Buffer.from(data.buffer, data.byteOffset, usableBytes);
		const samples = deinterleaveBuffer(sampleBuffer, this.outputChannels);

		const offset = this.frameOffset;

		this.frameOffset += frames;

		return {
			samples,
			offset,
			sampleRate: this.sourceSampleRate,
			bitDepth: this.sourceBitDepth,
		};
	}

	override async _destroy(): Promise<void> {
		const proc = this.ffmpegProcess;

		if (proc) {
			if (proc.exitCode === null && !proc.killed) {
				proc.kill("SIGTERM");

				await new Promise<void>((resolve) => {
					if (proc.exitCode !== null) {
						resolve();

						return;
					}

					const timer = setTimeout(() => {
						proc.kill("SIGKILL");
						resolve();
					}, TEARDOWN_KILL_GRACE_MS);

					proc.on("close", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}

			this.ffmpegProcess = undefined;
		}

		this.stdout = undefined;
		this.remainder = undefined;
	}

	private async probe(ffprobePath: string, filePath: string): Promise<ProbeResult> {
		const proc = spawn(ffprobePath, ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "a:0", filePath], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const chunks: Array<Buffer> = [];

		proc.stdout.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		proc.stderr.resume();

		await new Promise<void>((resolve, reject) => {
			proc.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`ffprobe exited with code ${code} for "${filePath}"`));
				} else {
					resolve();
				}
			});
			proc.on("error", (error) => {
				reject(new Error(`Failed to spawn ffprobe: ${error.message}`));
			});
		});

		const json = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
			streams?: Array<{
				sample_rate?: string;
				channels?: number;
				duration?: string;
			}>;
		};

		const stream = json.streams?.[0];

		if (!stream) {
			throw new Error(`No audio stream found in "${filePath}"`);
		}

		return {
			sampleRate: Number(stream.sample_rate) || 44100,
			channels: stream.channels ?? 1,
			duration: Number(stream.duration) || 0,
		};
	}

	private readBytes(targetBytes: number): Promise<Buffer | undefined> {
		return new Promise((resolve) => {
			const stdout = this.stdout;

			if (!stdout) {
				resolve(undefined);

				return;
			}

			const existing = this.remainder;

			this.remainder = undefined;

			const read = (): void => {
				const raw = stdout.read(targetBytes - (existing?.length ?? 0)) as Buffer | null;

				if (raw) {
					resolve(existing ? Buffer.concat([existing, raw]) : raw);

					return;
				}

				if ((stdout as NodeJS.ReadableStream & { readableEnded?: boolean }).readableEnded) {
					resolve(existing && existing.length > 0 ? existing : undefined);

					return;
				}

				const onReadable = (): void => {
					cleanup();
					read();
				};
				const onEnd = (): void => {
					cleanup();
					resolve(existing && existing.length > 0 ? existing : undefined);
				};
				const cleanup = (): void => {
					stdout.removeListener("readable", onReadable);
					stdout.removeListener("end", onEnd);
				};

				stdout.once("readable", onReadable);
				stdout.once("end", onEnd);
			};

			read();
		});
	}
}

export class ReadFfmpegNode extends SourceNode<ReadFfmpegProperties> {
	static override readonly nodeName = "Read FFmpeg";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Read audio from a file using FFmpeg";
	static override readonly schema = ffmpegSchema;
	static override readonly streamClass = ReadFfmpegStream;
	override readonly type = ["buffered-audio-node", "source", "read-ffmpeg"] as const;

	clone(overrides?: Partial<ReadFfmpegProperties>): ReadFfmpegNode {
		return new ReadFfmpegNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function readFfmpeg(path: string, options: { channels?: ReadonlyArray<number>; ffmpegPath: string; ffprobePath: string }): ReadFfmpegNode {
	return new ReadFfmpegNode({ path, channels: options.channels, ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath });
}
