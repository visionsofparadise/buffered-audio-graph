import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { interleave } from "@buffered-audio/utils";
import { PACKAGE_NAME } from "../../package-metadata";
import { appendStderr, buildInputArgs, buildOutputArgs, parseStdoutFrames, spawnFfmpegChild } from "./utils/process";

export const schema = z.object({
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
	args: z.array(z.string()).default([]),
	outputSampleRate: z.number().int().positive().optional().describe("Sample rate of emitted chunks. Required when args change the rate (e.g. -af aresample=24000)."),
});

export interface FfmpegProperties extends TransformNodeProperties {
	readonly ffmpegPath: string;
	readonly args?: Array<string> | ((context: StreamSetupContext) => Array<string>);
	readonly outputSampleRate?: number;
}

const TEARDOWN_KILL_GRACE_MS = 2000;

export class FfmpegStream<P extends FfmpegProperties = FfmpegProperties> extends UnbufferedTransformStream<FfmpegNode<P>> {
	private streamContext?: StreamSetupContext;

	private child?: ChildProcessWithoutNullStreams;
	private readonly pending: Array<Block> = [];
	private stdoutStash: Buffer = Buffer.alloc(0);
	private outputOffset = 0;
	private stderr = "";
	private stdinError?: Error;
	private exitPromise?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	private stdoutEndPromise?: Promise<void>;
	private pendingDrain?: Promise<void>;
	private inputSampleRate = 0;
	private inputChannels = 0;

	override _setup(context: StreamSetupContext): void {
		this.streamContext = context;
	}

	protected _buildArgs(context: StreamSetupContext): Array<string> {
		const { args } = this.properties;

		if (!args) return [];

		return typeof args === "function" ? args(context) : args;
	}

	private spawnChild(sampleRate: number, channels: number): void {
		if (!this.streamContext) throw new Error("FfmpegStream.spawnChild called before _setup()");

		this.inputSampleRate = sampleRate;
		this.inputChannels = channels;

		const outRate = this.properties.outputSampleRate ?? sampleRate;
		const args = [...buildInputArgs(sampleRate, channels), ...this._buildArgs(this.streamContext), ...buildOutputArgs(outRate, channels)];

		const { child, exitPromise, stdoutEndPromise } = spawnFfmpegChild({
			ffmpegPath: this.properties.ffmpegPath,
			args,
			onStderr: (chunk) => {
				this.stderr = appendStderr(this.stderr, chunk);
			},
			onStdout: (bytes) => this.handleStdoutBytes(bytes),
			onStdinError: (error) => {
				if (error.code === "EPIPE") return;

				this.stdinError ??= new Error(`ffmpeg stdin error: ${error.message}`);
			},
		});

		this.child = child;
		this.exitPromise = exitPromise;
		this.stdoutEndPromise = stdoutEndPromise;
	}

	private handleStdoutBytes(bytes: Buffer): void {
		const outRate = this.properties.outputSampleRate ?? this.inputSampleRate;
		const { block, stash, frameCount } = parseStdoutFrames(this.stdoutStash, bytes, this.inputChannels, this.outputOffset, outRate);

		this.stdoutStash = stash;

		if (!block) return;

		this.pending.push(block);
		this.outputOffset += frameCount;
	}

	override async *_transform(block: Block): AsyncGenerator<Block> {
		if (this.stdinError) throw this.stdinError;

		const channels = block.samples.length;
		const frames = block.samples[0]?.length ?? 0;

		if (frames === 0) return;

		if (!this.child) {
			this.spawnChild(block.sampleRate, channels);
		}

		const child = this.child;

		if (!child) throw new Error("FfmpegStream.child not initialized");

		const interleaved = interleave(block.samples, frames, channels);
		const buf = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);

		if (this.pendingDrain) {
			await this.pendingDrain;
		}

		const ok = child.stdin.write(buf);

		if (!ok) {
			this.pendingDrain = new Promise<void>((resolve) => {
				child.stdin.once("drain", () => {
					this.pendingDrain = undefined;
					resolve();
				});
			});
		}

		yield* this.pending.splice(0);
	}

	override async *_flush(): AsyncGenerator<Block> {
		const child = this.child;

		if (!child) return;

		if (this.pendingDrain) {
			await this.pendingDrain;
		}

		child.stdin.end();

		if (this.stdinError) throw this.stdinError;

		const stdoutEnd = this.stdoutEndPromise ?? Promise.resolve();
		const exit = this.exitPromise ?? Promise.resolve({ code: 0, signal: null });
		const [, exitResult] = await Promise.all([stdoutEnd, exit]);

		if (exitResult.code !== null && exitResult.code !== 0) {
			const detail = this.stderr ? `: ${this.stderr.slice(0, 1024)}` : "";

			throw new Error(`ffmpeg exited ${exitResult.code}${detail}`);
		}

		if (this.stdoutStash.length >= this.inputChannels * 4) {
			this.handleStdoutBytes(Buffer.alloc(0));
		}

		yield* this.pending.splice(0);
	}

	override async _destroy(): Promise<void> {
		const child = this.child;

		if (!child) return;

		if (child.exitCode === null && !child.killed) {
			child.kill("SIGTERM");

			await new Promise<void>((resolve) => {
				if (child.exitCode !== null) {
					resolve();

					return;
				}

				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, TEARDOWN_KILL_GRACE_MS);

				child.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}

		this.child = undefined;
	}
}

export class FfmpegNode<P extends FfmpegProperties = FfmpegProperties> extends TransformNode<P> {
	static override readonly nodeName: string = "FFmpeg";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description: string = "Process audio through FFmpeg filters";
	static override readonly schema: z.ZodType = schema;
	static override readonly Stream = FfmpegStream;
}

export function ffmpeg(options: { ffmpegPath: string; args: Array<string> | ((context: StreamSetupContext) => Array<string>); outputSampleRate?: number; id?: string }): FfmpegNode {
	return new FfmpegNode({
		ffmpegPath: options.ffmpegPath,
		args: options.args,
		outputSampleRate: options.outputSampleRate,
		id: options.id,
	});
}
