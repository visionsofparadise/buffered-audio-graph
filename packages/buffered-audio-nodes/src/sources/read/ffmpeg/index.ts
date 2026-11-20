import {
	BufferedSourceStream,
	ChildOutputBuffer,
	childFailure,
	releaseChild,
	runChild,
	SourceNode,
	spawnChild,
	terminateChild,
	type Block,
	type ChildHandle,
	type SourceMetadata,
	type SourceMetadataOptions,
	type SourceNodeProperties,
} from "@buffered-audio/core";
import { deinterleaveBuffer } from "@buffered-audio/utils";
import { z } from "zod";
import { PACKAGE_NAME } from "../../../package-metadata";
import { createFfmpegPathField } from "../../../utils/binary-fields";

export const ffmpegSchema = z.object({
	path: z.string().default("").meta({ input: "file", mode: "open" }),
	ffmpegPath: createFfmpegPathField(),
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
const PROBE_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;

interface ProbeResult {
	readonly sampleRate: number;
	readonly channels: number;
	readonly duration: number;
}

export class ReadFfmpegStream extends BufferedSourceStream<ReadFfmpegNode> {
	private handle?: ChildHandle;
	private stdoutBuffer?: ChildOutputBuffer;
	private frameOffset = 0;
	private outputChannels = 0;
	private sourceSampleRate = 0;
	private sourceBitDepth = 0;

	override async getMetadata(options?: SourceMetadataOptions): Promise<SourceMetadata> {
		const signal = options?.signal ? AbortSignal.any([this.streamSignal, options.signal]) : this.streamSignal;
		const probe = await this.probe(this.properties.ffprobePath, this.properties.path, signal);
		const selectedChannels = this.properties.channels;
		const channels = selectedChannels ? selectedChannels.length : probe.channels;

		return {
			sampleRate: probe.sampleRate,
			channels,
			durationFrames: Math.round(probe.duration * probe.sampleRate),
		};
	}

	private async ensureInitialized(): Promise<void> {
		if (this.handle) return;

		const probe = await this.probe(this.properties.ffprobePath, this.properties.path, this.streamSignal);

		this.throwIfStopped();

		const selectedChannels = this.properties.channels;

		this.outputChannels = selectedChannels ? selectedChannels.length : probe.channels;
		this.sourceSampleRate = probe.sampleRate;
		this.sourceBitDepth = 32;

		const args = [
			"-hide_banner",
			"-nostats",
			"-loglevel",
			"error",
			"-i",
			this.properties.path,
			"-f",
			"f32le",
			"-acodec",
			"pcm_f32le",
			"-ar",
			String(probe.sampleRate),
		];

		if (selectedChannels) {
			const panParts = selectedChannels.map((srcCh, outCh) => `c${outCh}=c${srcCh}`);
			const layout = this.outputChannels === 1 ? "mono" : `${this.outputChannels}c`;

			args.push("-af", `pan=${layout}|${panParts.join("|")}`);
			args.push("-ac", String(this.outputChannels));
		} else {
			args.push("-ac", String(probe.channels));
		}

		args.push("pipe:1");

		const handle = spawnChild({ label: "ffmpeg", command: this.properties.ffmpegPath, args, stdin: "ignore" });

		this.handle = handle;
		this.stdoutBuffer = new ChildOutputBuffer(handle, { signal: this.streamSignal });
		this.frameOffset = 0;
	}

	override async _read(): Promise<Block | undefined> {
		await this.ensureInitialized();

		const bytesPerFrame = this.outputChannels * 4;
		const targetBytes = DEFAULT_CHUNK_SIZE * bytesPerFrame;

		const data = await this.readBytes(targetBytes);

		this.throwIfStopped();

		if (!data || data.length === 0) {
			await this.endOfStream();

			return undefined;
		}

		const usableBytes = Math.floor(data.length / bytesPerFrame) * bytesPerFrame;

		if (usableBytes === 0) {
			await this.endOfStream();

			return undefined;
		}

		const leftover = data.length - usableBytes;

		if (leftover > 0) {
			this.stdoutBuffer?.unshift(Buffer.from(data.buffer, data.byteOffset + usableBytes, leftover));
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
		const handle = this.handle;

		if (handle) {
			handle.stdout?.destroy();
			await terminateChild(handle.child, { firstSignal: "SIGKILL" });
			releaseChild(handle);
			this.stdoutBuffer?.dispose();
		}

		this.handle = undefined;
		this.stdoutBuffer = undefined;
	}

	private async endOfStream(): Promise<void> {
		const failure = this.handle ? await childFailure(this.handle, { signal: this.streamSignal }) : undefined;

		this.throwIfStopped();

		if (failure) throw failure;
	}

	private async probe(ffprobePath: string, filePath: string, signal: AbortSignal): Promise<ProbeResult> {
		const result = await runChild({
			label: "ffprobe",
			command: ffprobePath,
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				"-print_format",
				"json",
				"-show_streams",
				"-select_streams",
				"a:0",
				filePath,
			],
			signal,
			stdoutLimitBytes: PROBE_STDOUT_LIMIT_BYTES,
		}).catch((error: unknown) => {
			if (signal.aborted) throw signal.reason;

			throw new Error(`Cannot probe "${filePath}": ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
		});

		if (result.failure)
			throw new Error(`Cannot probe "${filePath}": ${result.failure.message}`, { cause: result.failure });

		let json: { streams?: Array<{ sample_rate?: string; channels?: number; duration?: string }> };

		try {
			json = JSON.parse(result.stdout.toString("utf-8")) as typeof json;
		} catch (error) {
			throw new Error(
				`Cannot probe "${filePath}": ffprobe printed unreadable JSON (${error instanceof Error ? error.message : String(error)})`,
				{ cause: error },
			);
		}

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

	private async readBytes(targetBytes: number): Promise<Buffer | undefined> {
		const buffer = this.stdoutBuffer;

		if (!buffer) return undefined;

		for (;;) {
			buffer.throwIfFailed();
			buffer.pull();

			if (buffer.length >= targetBytes) return buffer.take(targetBytes);

			if (buffer.ended) return buffer.take();

			await buffer.nextChange();
		}
	}
}

export class ReadFfmpegNode extends SourceNode<ReadFfmpegProperties> {
	static override readonly nodeName = "Read FFmpeg";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Read audio from a file using FFmpeg";
	static override readonly schema = ffmpegSchema;
	static override readonly Stream = ReadFfmpegStream;
}

export function readFfmpeg(
	path: string,
	options: { channels?: ReadonlyArray<number>; ffmpegPath: string; ffprobePath: string },
): ReadFfmpegNode {
	return new ReadFfmpegNode({
		path,
		channels: options.channels,
		ffmpegPath: options.ffmpegPath,
		ffprobePath: options.ffprobePath,
	});
}
