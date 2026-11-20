import { basename } from "node:path";
import {
	ChildOutputBuffer,
	childFailure,
	releaseChild,
	spawnChild,
	terminateChild,
	TransformNode,
	UnbufferedTransformStream,
	waitForChildWritable,
	type Block,
	type BufferedAudioNode,
	type ChildHandle,
	type StreamSetupContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { encodePcm, PcmStreamDecoder } from "./utils/pcm";
import { buildStreamingWavHeader, WavStreamParser } from "./utils/wav-stream";
import type { WavFormat } from "../../sources/read/wav/utils/wav-format";

const CHILD_EXIT_WAIT_MS = 2000;

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

	private handle?: ChildHandle;
	private stdoutBuffer?: ChildOutputBuffer;
	private label = "";
	private decoder?: OutputDecoder;
	private output?: OutputShape;
	private outputOffset = 0;
	private childSettled = false;
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
		const handle = spawnChild({ label, command, args });

		this.handle = handle;
		this.stdoutBuffer = new ChildOutputBuffer(handle, { signal: this.streamSignal });

		void handle.closed.then(() => {
			this.childSettled = true;
			this.stdoutBuffer?.notify();
		});

		if (this._inputFormat() === "wav") handle.stdin?.write(buildStreamingWavHeader(input.sampleRate, input.channels));
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

	private async *decode(bytes: Buffer): AsyncGenerator<Block> {
		let samples: Array<Float32Array> | undefined;

		try {
			samples = this.decoder?.push(bytes);
		} catch (error) {
			await this.failDecode(error);
		}

		const block = this.toBlock(samples);

		if (block) yield block;
	}

	private async *readAvailableStdout(): AsyncGenerator<Block> {
		const buffer = this.stdoutBuffer;

		if (!buffer) return;

		buffer.pull();

		const bytes = buffer.take();

		if (bytes) yield* this.decode(bytes);
	}

	private async *serveOutput(stop: () => boolean): AsyncGenerator<Block> {
		const buffer = this.stdoutBuffer;

		if (!buffer) return;

		for (;;) {
			if (buffer.failure) throw buffer.failure;

			buffer.pull();

			const bytes = buffer.take();

			if (bytes) {
				yield* this.decode(bytes);

				continue;
			}

			if (stop()) return;

			await buffer.nextChange();
		}
	}

	private flushOutput(): AsyncGenerator<Block> {
		return this.serveOutput(() => this.stdoutBuffer?.ended ?? true);
	}

	private async *serveWhileParked(): AsyncGenerator<Block> {
		yield* this.serveOutput(() => this.pendingDrain === undefined || this.stdoutBuffer?.ended !== false);

		const drain = this.pendingDrain;

		if (drain) await drain;
	}

	private async failDecode(error: unknown): Promise<never> {
		const failure = this.handle
			? await childFailure(this.handle, {
					signal: this.streamSignal,
					exitWithinMs: CHILD_EXIT_WAIT_MS,
					discardOutput: true,
				})
			: undefined;

		throw failure ?? (error instanceof Error ? error : new Error(String(error)));
	}

	private aborted(): boolean {
		return this.streamSignal.aborted;
	}

	private async throwIfFailed(): Promise<void> {
		if (!this.handle) return;

		const failure = await childFailure(this.handle, { signal: this.streamSignal });

		if (failure) throw failure;
	}

	private async checkChild(handle: ChildHandle): Promise<boolean> {
		const { child } = handle;

		if (child.exitCode !== null || child.signalCode !== null || this.childSettled) {
			await this.throwIfFailed();

			return true;
		}

		const stdinError = handle.stdinError();

		if (stdinError) throw stdinError;

		return false;
	}

	override async *_transform(block: Block): AsyncGenerator<Block> {
		const channels = block.samples.length;
		const frames = block.samples[0]?.length ?? 0;

		if (frames === 0) return;

		if (!this.handle) {
			if (this.isDestroyed || this.aborted()) return;

			this.spawnChild(block, channels);
		}

		const handle = this.handle;
		const stdin = handle?.stdin;

		if (!handle || !stdin) throw new Error("CliTransformStream.child not initialized");

		if (await this.checkChild(handle)) {
			yield* this.readAvailableStdout();

			return;
		}

		const ok = stdin.write(encodePcm(block.samples, frames, this._inputFormat() === "f64le" ? "f64le" : "f32le"));

		if (!ok) {
			const drain = waitForChildWritable(handle.child, stdin, this.streamSignal).then(() => {
				if (this.pendingDrain === drain) this.pendingDrain = undefined;

				this.stdoutBuffer?.notify();
			});

			this.pendingDrain = drain;
		}

		yield* this.serveWhileParked();

		if (this.aborted()) return;

		await this.checkChild(handle);

		yield* this.readAvailableStdout();
	}

	override async *_flush(): AsyncGenerator<Block> {
		const handle = this.handle;

		if (!handle) return;

		yield* this.serveWhileParked();

		if (this.aborted()) return;

		handle.stdin?.end();

		await this.checkChild(handle);

		yield* this.flushOutput();

		if (this.aborted()) return;

		await this.throwIfFailed();

		const tail = this.toBlock(this.decoder?.end());

		if (tail) yield tail;
	}

	override async _destroy(): Promise<void> {
		const handle = this.handle;

		if (!handle) return;

		const { child } = handle;
		const running = child.exitCode === null && child.signalCode === null && !child.killed;
		const exited = running ? terminateChild(child) : Promise.resolve();

		handle.stdout?.destroy();

		await exited;

		releaseChild(handle);
		this.stdoutBuffer?.dispose();
		this.handle = undefined;
		this.stdoutBuffer = undefined;
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
