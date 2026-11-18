import { basename } from "node:path";
import {
	UnbufferedTransformStream,
	TransformNode,
	type Block,
	type BufferedAudioNode,
	type StreamSetupContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { encodePcm, PcmStreamDecoder } from "./utils/pcm";
import {
	appendStderr,
	exitError,
	settleWithin,
	spawnCliChild,
	terminateChild,
	unlessAborted,
	waitForChildWritable,
	type CliChildHandle,
	type CliExitResult,
} from "./utils/process";
import { buildStreamingWavHeader, WavStreamParser } from "./utils/wav-stream";
import type { WavFormat } from "../../sources/read/wav/utils/wav-format";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

const CHILD_CLOSE_WAIT_MS = 2000;

export type CliStreamFormat = "wav" | "f32le" | "f64le";

export interface CliStreamInput {
	readonly sampleRate: number;
	readonly channels: number;
}

interface OutputDecoder {
	readonly push: (bytes: Buffer) => Array<Float32Array> | undefined;
	readonly end: () => Array<Float32Array> | undefined;
}

interface OutputShape {
	readonly sampleRate: number;
	readonly channels: number;
	readonly bitDepth: number;
}

export abstract class CliTransformStream<
	N extends BufferedAudioNode<TransformNodeProperties> = BufferedAudioNode<TransformNodeProperties>,
> extends UnbufferedTransformStream<N> {
	private streamContext?: StreamSetupContext;

	private child?: ChildProcessWithoutNullStreams;
	private label = "";
	private decoder?: OutputDecoder;
	private output?: OutputShape;
	private outputOffset = 0;
	private stderr = "";
	private stdinError?: Error;
	private exitPromise?: Promise<CliExitResult>;
	private childSettled = false;
	private childClosed?: Promise<void>;
	private stdoutEnded = false;
	private stdoutWait?: Promise<void>;
	private stdoutNotify?: () => void;
	private pendingDrain?: Promise<void>;

	protected abstract _command(): string;
	protected abstract _label(): string;
	protected abstract _buildArgs(context: StreamSetupContext, input: CliStreamInput): Array<string>;

	protected _inputFormat(): CliStreamFormat {
		return "f32le";
	}

	protected _outputFormat(): CliStreamFormat {
		return "f32le";
	}

	protected _outputSampleRate(): number | undefined {
		return undefined;
	}

	protected _outputChannels(): number | undefined {
		return undefined;
	}

	override _setup(context: StreamSetupContext): void {
		this.streamContext = context;
		this.recordRenderSignal(context);

		const outputSampleRate = this._outputSampleRate();

		if (outputSampleRate !== undefined) context.sampleRate = outputSampleRate;
	}

	private spawnChild(block: Block, channels: number): void {
		if (!this.streamContext) throw new Error("CliTransformStream.spawnChild called before _setup()");

		const input: CliStreamInput = { sampleRate: block.sampleRate, channels };
		const label = this._label();

		this.label = label;
		this.output = {
			sampleRate: this._outputSampleRate() ?? input.sampleRate,
			channels: this._outputChannels() ?? input.channels,
			bitDepth: block.bitDepth,
		};
		this.decoder = this.createDecoder(this.output);

		const command = this._command();

		if (command === "") throw new Error(`${this.identity.nodeName} node has no command`);

		const args = this._buildArgs(this.streamContext, input);
		let handle: CliChildHandle;

		try {
			handle = spawnCliChild({
				command,
				args,
				onStderr: (chunk) => {
					this.stderr = appendStderr(this.stderr, chunk);
				},
				onStdinError: (error) => {
					if (error.code === "EPIPE" || error.code === "EOF") return;

					this.stdinError ??= new Error(`${label} stdin error: ${error.message}`);
				},
			});
		} catch (error) {
			throw new Error(`${label} failed to start: ${error instanceof Error ? error.message : String(error)}`);
		}

		const { child, exitPromise } = handle;

		child.stdout.on("readable", this.onStdoutReadable);
		child.stdout.on("end", this.onStdoutEnd);

		this.childClosed = new Promise<void>((resolve) => {
			const settleChild = (): void => {
				this.childSettled = true;
				this.wakeStdout();
				resolve();
			};

			child.once("close", settleChild);
			child.once("error", settleChild);
		});
		this.child = child;
		this.exitPromise = exitPromise;

		if (this._inputFormat() === "wav") child.stdin.write(buildStreamingWavHeader(input.sampleRate, input.channels));
	}

	private createDecoder(output: OutputShape): OutputDecoder {
		const format = this._outputFormat();

		if (format !== "wav") return new PcmStreamDecoder(output.channels, format);

		const parser = new WavStreamParser();

		return {
			push: (bytes) => {
				const { header, samples } = parser.push(bytes);

				if (header) this.checkWavHeader(header, output);

				return samples;
			},
			end: () => parser.end(),
		};
	}

	private checkWavHeader(header: WavFormat, output: OutputShape): void {
		if (header.sampleRate !== output.sampleRate) {
			throw new Error(
				`${this.label} output WAV has sample rate ${header.sampleRate}, expected ${output.sampleRate}`,
			);
		}

		if (header.channels !== output.channels) {
			throw new Error(`${this.label} output WAV has ${header.channels} channels, expected ${output.channels}`);
		}
	}

	private readonly onStdoutReadable = (): void => {
		this.wakeStdout();
	};

	private readonly onStdoutEnd = (): void => {
		this.stdoutEnded = true;
		this.wakeStdout();
	};

	private wakeStdout(): void {
		const notify = this.stdoutNotify;

		this.stdoutNotify = undefined;
		this.stdoutWait = undefined;
		notify?.();
	}

	private toBlock(samples: Array<Float32Array> | undefined): Block | undefined {
		const frames = samples?.[0]?.length ?? 0;

		if (!samples || !this.output || frames === 0) return undefined;

		const block: Block = {
			samples,
			offset: this.outputOffset,
			sampleRate: this.output.sampleRate,
			bitDepth: this.output.bitDepth,
		};

		this.outputOffset += frames;

		return block;
	}

	private async *readAvailableStdout(): AsyncGenerator<Block> {
		const stdout = this.child?.stdout;
		const decoder = this.decoder;

		if (!stdout || !decoder) return;

		for (;;) {
			const bytes = stdout.read() as Buffer | null;

			if (!bytes) return;

			let samples: Array<Float32Array> | undefined;

			try {
				samples = decoder.push(bytes);
			} catch (error) {
				await this.failDecode(error, stdout);
			}

			const block = this.toBlock(samples);

			if (block) yield block;
		}
	}

	private async waitForChildClose(stdout: Readable | undefined): Promise<void> {
		stdout?.off("readable", this.onStdoutReadable);
		stdout?.resume();

		if (this.childClosed) await settleWithin(this.childClosed, CHILD_CLOSE_WAIT_MS, this.streamSignal);
	}

	private async failDecode(error: unknown, stdout: Readable): Promise<never> {
		await this.waitForChildClose(stdout);

		if (this.childSettled && this.exitPromise) {
			const exit = exitError(this.label, await this.exitPromise, this.stderr);

			if (exit) throw exit;
		}

		throw error instanceof Error ? error : new Error(String(error));
	}

	private waitForStdoutReadableOrEnd(): Promise<void> {
		const stdout = this.child?.stdout;
		const signal = this.streamSignal;

		if (!stdout || this.stdoutEnded || signal.aborted) return Promise.resolve();

		if (stdout.readableLength > 0) return Promise.resolve();

		if (stdout.readableEnded) {
			this.stdoutEnded = true;

			return Promise.resolve();
		}

		if (this.stdoutWait) return this.stdoutWait;

		const wait = new Promise<void>((resolve) => {
			const onAbort = (): void => this.wakeStdout();

			signal.addEventListener("abort", onAbort, { once: true });

			this.stdoutNotify = () => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
		});

		this.stdoutWait = wait;

		return wait;
	}

	private async *serveWhileParked(): AsyncGenerator<Block> {
		for (;;) {
			yield* this.readAvailableStdout();

			if (this.aborted()) return;

			const drain = this.pendingDrain;

			if (drain === undefined) return;

			if (this.stdoutEnded) {
				await drain;

				return;
			}

			await Promise.race([drain, this.waitForStdoutReadableOrEnd()]);
		}
	}

	private aborted(): boolean {
		return this.streamSignal.aborted;
	}

	private async throwIfFailed(): Promise<void> {
		if (!this.exitPromise) return;

		const exit = await unlessAborted(this.exitPromise, this.streamSignal);

		if (!exit || exit.code === 0) return;

		await this.waitForChildClose(this.child?.stdout);

		const error = exitError(this.label, exit, this.stderr);

		if (error) throw error;
	}

	private async checkChild(child: ChildProcessWithoutNullStreams): Promise<boolean> {
		if (child.exitCode !== null || child.signalCode !== null || this.childSettled) {
			await this.throwIfFailed();

			return true;
		}

		if (this.stdinError) throw this.stdinError;

		return false;
	}

	override async *_transform(block: Block): AsyncGenerator<Block> {
		const channels = block.samples.length;
		const frames = block.samples[0]?.length ?? 0;

		if (frames === 0) return;

		if (!this.child) {
			if (this.isDestroyed || this.aborted()) return;

			this.spawnChild(block, channels);
		}

		const child = this.child;

		if (!child) throw new Error("CliTransformStream.child not initialized");

		if (await this.checkChild(child)) {
			yield* this.readAvailableStdout();

			return;
		}

		const ok = child.stdin.write(
			encodePcm(block.samples, frames, this._inputFormat() === "f64le" ? "f64le" : "f32le"),
		);

		if (!ok) {
			this.pendingDrain = waitForChildWritable(child, child.stdin, this.streamSignal).then(() => {
				this.pendingDrain = undefined;
			});
		}

		yield* this.serveWhileParked();

		if (this.aborted()) return;

		await this.checkChild(child);

		yield* this.readAvailableStdout();
	}

	override async *_flush(): AsyncGenerator<Block> {
		const child = this.child;

		if (!child) return;

		yield* this.serveWhileParked();

		if (this.aborted()) return;

		child.stdin.end();

		await this.checkChild(child);

		for (;;) {
			yield* this.readAvailableStdout();

			if (this.stdoutEnded || this.childSettled || this.aborted()) break;

			await this.waitForStdoutReadableOrEnd();
		}

		if (this.aborted()) return;

		await this.throwIfFailed();

		const tail = this.toBlock(this.decoder?.end());

		if (tail) yield tail;
	}

	override async _destroy(): Promise<void> {
		const child = this.child;

		if (!child) return;

		const running = child.exitCode === null && child.signalCode === null && !child.killed;
		const exited = running ? terminateChild(child) : Promise.resolve();

		child.stdout.off("readable", this.onStdoutReadable);
		child.stdout.off("end", this.onStdoutEnd);
		child.stdout.destroy();

		await exited;

		this.child = undefined;
	}
}

const formatSchema = z.enum(["wav", "f32le", "f64le"]).default("f32le");

const schema = z.object({
	command: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open" })
		.describe(
			"Executable to run: a path, or a bare name resolved through PATH. It runs without a shell, so Windows .cmd and .bat shims are not supported.",
		),
	args: z
		.array(z.string())
		.default([])
		.describe(
			"Arguments for the command. {sampleRate} and {channels} become the input stream's sample rate and channel count.",
		),
	inputFormat: formatSchema.describe("Format written to the command's stdin: wav (32-bit float), f32le or f64le"),
	outputFormat: formatSchema.describe("Format read from the command's stdout: wav, f32le or f64le"),
	outputSampleRate: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Sample rate the command emits. Required when the command changes the rate."),
	outputChannels: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Channel count the command emits. Required when the command changes the channel count."),
});

export interface CliProperties extends TransformNodeProperties {
	readonly command: string;
	readonly args?: Array<string>;
	readonly inputFormat?: CliStreamFormat;
	readonly outputFormat?: CliStreamFormat;
	readonly outputSampleRate?: number;
	readonly outputChannels?: number;
}

export class CliStream extends CliTransformStream<CliNode> {
	protected override _command(): string {
		return this.properties.command;
	}

	protected override _label(): string {
		return basename(this.properties.command);
	}

	protected override _buildArgs(_context: StreamSetupContext, input: CliStreamInput): Array<string> {
		return (this.properties.args ?? []).map((arg) =>
			arg.replaceAll("{sampleRate}", String(input.sampleRate)).replaceAll("{channels}", String(input.channels)),
		);
	}

	protected override _inputFormat(): CliStreamFormat {
		return this.properties.inputFormat ?? "f32le";
	}

	protected override _outputFormat(): CliStreamFormat {
		return this.properties.outputFormat ?? "f32le";
	}

	protected override _outputSampleRate(): number | undefined {
		return this.properties.outputSampleRate;
	}

	protected override _outputChannels(): number | undefined {
		return this.properties.outputChannels;
	}
}

export class CliNode extends TransformNode<CliProperties> {
	static override readonly nodeName: string = "CLI";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description: string =
		"Process audio through any command-line tool over stdin and stdout. The bag runs the named executable with full system access.";
	static override readonly schema: z.ZodType = schema;
	static override readonly Stream = CliStream;
}

export function cli(options: CliProperties & { readonly id?: string }): CliNode {
	return new CliNode(options);
}
