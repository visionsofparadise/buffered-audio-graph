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
	private stdoutStash: Buffer = Buffer.alloc(0);
	private outputOffset = 0;
	private stderr = "";
	private stdinError?: Error;
	private exitPromise?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	private stdoutEnded = false;
	private stdoutWait?: Promise<void>;
	private stdoutNotify?: () => void;
	private pendingDrain?: Promise<void>;
	private inputSampleRate = 0;
	private inputChannels = 0;

	override _setup(context: StreamSetupContext): void {
		this.streamContext = context;

		if (this.properties.outputSampleRate !== undefined) context.sampleRate = this.properties.outputSampleRate;
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

		const { child, exitPromise } = spawnFfmpegChild({
			ffmpegPath: this.properties.ffmpegPath,
			args,
			onStderr: (chunk) => {
				this.stderr = appendStderr(this.stderr, chunk);
			},
			onStdinError: (error) => {
				if (error.code === "EPIPE") return;

				this.stdinError ??= new Error(`ffmpeg stdin error: ${error.message}`);
			},
		});

		child.stdout.on("readable", () => this.wakeStdout());
		child.stdout.on("end", () => {
			this.stdoutEnded = true;
			this.wakeStdout();
		});

		this.child = child;
		this.exitPromise = exitPromise;
	}

	private wakeStdout(): void {
		const notify = this.stdoutNotify;

		this.stdoutNotify = undefined;
		this.stdoutWait = undefined;
		notify?.();
	}

	private *readAvailableStdout(): Generator<Block> {
		const stdout = this.child?.stdout;

		if (!stdout) return;

		const outRate = this.properties.outputSampleRate ?? this.inputSampleRate;

		for (;;) {
			const bytes = stdout.read() as Buffer | null;

			if (!bytes) return;

			const { block, stash, frameCount } = parseStdoutFrames(this.stdoutStash, bytes, this.inputChannels, this.outputOffset, outRate);

			this.stdoutStash = stash;

			if (block) {
				this.outputOffset += frameCount;

				yield block;
			}
		}
	}

	private waitForStdoutReadableOrEnd(): Promise<void> {
		const stdout = this.child?.stdout;

		if (!stdout || this.stdoutEnded) return Promise.resolve();

		// Node re-arms 'readable' only while readableLength <= highWaterMark, so parking on buffered bytes never wakes.
		if (stdout.readableLength > 0) return Promise.resolve();

		if (stdout.readableEnded) {
			this.stdoutEnded = true;

			return Promise.resolve();
		}

		if (this.stdoutWait) return this.stdoutWait;

		const wait = new Promise<void>((resolve) => {
			this.stdoutNotify = resolve;
		});

		this.stdoutWait = wait;

		return wait;
	}

	private async *serveWhileParked(): AsyncGenerator<Block> {
		for (;;) {
			yield* this.readAvailableStdout();

			const drain = this.pendingDrain;

			if (drain === undefined) return;

			if (this.stdoutEnded) {
				await drain;

				return;
			}

			await Promise.race([drain, this.waitForStdoutReadableOrEnd()]);
		}
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

		const ok = child.stdin.write(buf);

		if (!ok) {
			this.pendingDrain = new Promise<void>((resolve) => {
				child.stdin.once("drain", () => {
					this.pendingDrain = undefined;
					resolve();
				});
			});
		}

		yield* this.serveWhileParked();
		yield* this.readAvailableStdout();
	}

	override async *_flush(): AsyncGenerator<Block> {
		const child = this.child;

		if (!child) return;

		yield* this.serveWhileParked();

		child.stdin.end();

		if (this.stdinError) throw this.stdinError;

		for (;;) {
			yield* this.readAvailableStdout();

			if (this.stdoutEnded) break;

			await this.waitForStdoutReadableOrEnd();
		}

		if (this.stdoutStash.length >= this.inputChannels * 4) {
			const outRate = this.properties.outputSampleRate ?? this.inputSampleRate;
			const { block } = parseStdoutFrames(this.stdoutStash, Buffer.alloc(0), this.inputChannels, this.outputOffset, outRate);

			this.stdoutStash = Buffer.alloc(0);

			if (block) yield block;
		}

		const exitResult = await (this.exitPromise ?? Promise.resolve({ code: 0, signal: null }));

		if (exitResult.code !== null && exitResult.code !== 0) {
			const detail = this.stderr ? `: ${this.stderr.slice(0, 1024)}` : "";

			throw new Error(`ffmpeg exited ${exitResult.code}${detail}`);
		}
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
