import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { interleave } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
	args: z.array(z.string()).default([]),
	outputSampleRate: z.number().int().positive().optional().describe("Sample rate of emitted chunks. Required when args change the rate (e.g. -af aresample=24000)."),
});

export interface FfmpegProperties extends TransformNodeProperties {
	readonly ffmpegPath: string;
	readonly args?: Array<string> | ((context: StreamContext) => Array<string>);
	readonly outputSampleRate?: number;
}

const STDERR_CAP_BYTES = 64 * 1024;

export class FfmpegStream<P extends FfmpegProperties = FfmpegProperties> extends BufferedTransformStream<P> {
	private streamContext?: StreamContext;
	private _sourceTotalFrames?: number;

	private child?: ChildProcessWithoutNullStreams;
	private stdoutStash: Buffer = Buffer.alloc(0);
	private outputOffset = 0;
	private stderr = "";
	private exitPromise?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	private stdoutEndPromise?: Promise<void>;
	private pendingDrain?: Promise<void>;
	private inputSampleRate = 0;
	private inputChannels = 0;
	private hasStartedEvent = false;

	override async _setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		this.streamContext = context;
		this._sourceTotalFrames = context.durationFrames;

		return super._setup(input, context);
	}

	protected _buildArgs(_context: StreamContext): Array<string> {
		const { args } = this.properties;

		if (!args) return [];

		return typeof args === "function" ? args(_context) : args;
	}

	protected _buildOutputArgs(_context: StreamContext): Array<string> {
		const outRate = this.properties.outputSampleRate ?? this.inputSampleRate;

		return ["-f", "f32le", "-ar", String(outRate), "-ac", String(this.inputChannels), "pipe:1"];
	}

	override createTransformStream(): TransformStream<Block, Block> {
		return new TransformStream<Block, Block>({
			transform: (chunk, controller) => this.handleChunk(chunk, controller),
			flush: (controller) => this.handleFlushStream(controller),
		});
	}

	private spawnChild(sampleRate: number, channels: number, controller: TransformStreamDefaultController<Block>): void {
		if (!this.streamContext) throw new Error("FfmpegStream.spawnChild called before _setup()");

		this.inputSampleRate = sampleRate;
		this.inputChannels = channels;

		const inputArgs = ["-f", "f32le", "-ar", String(sampleRate), "-ac", String(channels), "-i", "pipe:0"];
		const filterArgs = this._buildArgs(this.streamContext);
		const outputArgs = this._buildOutputArgs(this.streamContext);
		const args = [...inputArgs, ...filterArgs, ...outputArgs];

		const child = spawn(this.properties.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });

		this.child = child;

		child.stderr.on("data", (chunk: Buffer) => {
			if (this.stderr.length >= STDERR_CAP_BYTES) return;

			const remaining = STDERR_CAP_BYTES - this.stderr.length;
			const text = chunk.toString("utf8");

			this.stderr += text.length > remaining ? text.slice(0, remaining) : text;
		});

		child.stdout.on("data", (bytes: Buffer) => {
			this.handleStdoutBytes(bytes, controller);
		});

		// Surface EPIPE / spawn errors that arrive on stdin.
		child.stdin.on("error", (error: Error & { code?: string }) => {
			if (error.code === "EPIPE") return;

			controller.error(new Error(`ffmpeg stdin error: ${error.message}`));
		});

		this.exitPromise = new Promise((resolve) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});

		this.stdoutEndPromise = new Promise((resolve) => {
			child.stdout.once("end", () => resolve());
		});
	}

	private handleStdoutBytes(bytes: Buffer, controller: TransformStreamDefaultController<Block>): void {
		const merged = this.stdoutStash.length > 0 ? Buffer.concat([this.stdoutStash, bytes]) : bytes;
		const frameBytes = this.inputChannels * 4;

		if (frameBytes === 0) {
			this.stdoutStash = merged;

			return;
		}

		const completeBytes = merged.length - (merged.length % frameBytes);

		if (completeBytes === 0) {
			this.stdoutStash = merged;

			return;
		}

		const frameCount = completeBytes / frameBytes;
		const totalFloats = completeBytes / 4;

		// `merged.byteOffset` may not be 4-aligned (Buffer pools and Buffer.concat
		// can produce unaligned views). Float32Array requires byte-offset divisible
		// by 4; if not, copy into a fresh aligned buffer.
		let floatView: Float32Array;

		if ((merged.byteOffset % 4) === 0) {
			floatView = new Float32Array(merged.buffer, merged.byteOffset, totalFloats);
		} else {
			const aligned = Buffer.allocUnsafe(completeBytes);

			merged.copy(aligned, 0, 0, completeBytes);
			floatView = new Float32Array(aligned.buffer, aligned.byteOffset, totalFloats);
		}

		const channels = this.inputChannels;
		const samples: Array<Float32Array> = [];

		for (let ch = 0; ch < channels; ch++) {
			samples.push(new Float32Array(frameCount));
		}

		for (let frame = 0; frame < frameCount; frame++) {
			for (let ch = 0; ch < channels; ch++) {
				const channelArray = samples[ch];

				if (channelArray) {
					channelArray[frame] = floatView[frame * channels + ch] ?? 0;
				}
			}
		}

		const outRate = this.properties.outputSampleRate ?? this.inputSampleRate;

		const audioChunk: Block = {
			samples,
			offset: this.outputOffset,
			sampleRate: outRate,
			bitDepth: 32,
		};

		controller.enqueue(audioChunk);
		this.outputOffset += frameCount;
		this.emitProgress("emit", this.outputOffset);

		this.stdoutStash = merged.subarray(completeBytes);
	}

	private async handleChunk(chunk: Block, controller: TransformStreamDefaultController<Block>): Promise<void> {
		const channels = chunk.samples.length;
		const frames = chunk.samples[0]?.length ?? 0;

		if (frames === 0) return;

		if (!this.child) {
			this.spawnChild(chunk.sampleRate, channels, controller);
		}

		if (!this.hasStartedEvent) {
			this.hasStartedEvent = true;
			this.events.emit("started");
		}

		const child = this.child;

		if (!child) throw new Error("FfmpegStream.child not initialized");

		const interleaved = interleave(chunk.samples, frames, channels);
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

		this.framesProcessed += frames;
		this.emitProgress("buffer", this.framesProcessed, this._sourceTotalFrames);
	}

	private async handleFlushStream(controller: TransformStreamDefaultController<Block>): Promise<void> {
		const child = this.child;

		if (!child) {
			this.emitProgress("buffer", this.framesProcessed, this._sourceTotalFrames, { force: true });
			this.emitProgress("emit", this.outputOffset, undefined, { force: true });
			this.events.emit("finished", { framesDone: this.framesProcessed });

			return;
		}

		if (this.pendingDrain) {
			await this.pendingDrain;
		}

		child.stdin.end();

		// EOF flush ordering: must await BOTH stdout 'end' AND child 'exit' before
		// draining the final stash. Awaiting only one risks truncating ffmpeg's
		// filter-graph tail samples.
		const stdoutEnd = this.stdoutEndPromise ?? Promise.resolve();
		const exit = this.exitPromise ?? Promise.resolve({ code: 0, signal: null });
		const [, exitResult] = await Promise.all([stdoutEnd, exit]);

		if (exitResult.code !== null && exitResult.code !== 0) {
			const detail = this.stderr ? `: ${this.stderr.slice(0, 1024)}` : "";

			throw new Error(`ffmpeg exited ${exitResult.code}${detail}`);
		}

		// Drain complete frames that arrived after the last 'data' event but before 'end' (listener race).
		// Sub-frame trailing bytes are discarded (would be an ffmpeg-side bug).
		if (this.stdoutStash.length >= this.inputChannels * 4) {
			this.handleStdoutBytes(Buffer.alloc(0), controller);
		}

		this.emitProgress("buffer", this.framesProcessed, this._sourceTotalFrames, { force: true });
		this.emitProgress("emit", this.outputOffset, undefined, { force: true });
		this.events.emit("finished", { framesDone: this.framesProcessed });
	}

	override async _teardown(): Promise<void> {
		const child = this.child;

		if (!child) return;

		if (child.exitCode === null && !child.killed) {
			child.kill("SIGTERM");

			try {
				await this.exitPromise;
			} catch {
				// Best effort — teardown should not throw.
			}
		}

		this.child = undefined;
	}
}

export class FfmpegNode<P extends FfmpegProperties = FfmpegProperties> extends TransformNode<P> {
	static override readonly nodeName: string = "FFmpeg";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription: string = "Process audio through FFmpeg filters";
	static override readonly schema: z.ZodType = schema;
	static override is(value: unknown): value is FfmpegNode {
		return TransformNode.is(value) && value.type[2] === "ffmpeg";
	}

	override readonly type: ReadonlyArray<string> = ["buffered-audio-node", "transform", "ffmpeg"];

	constructor(properties: P) {
		super({ bufferSize: 0, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): FfmpegStream<P> {
		return new FfmpegStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<P>): FfmpegNode<P> {
		return new FfmpegNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function ffmpeg(options: { ffmpegPath: string; args: Array<string> | ((context: StreamContext) => Array<string>); outputSampleRate?: number; id?: string }): FfmpegNode {
	return new FfmpegNode({
		ffmpegPath: options.ffmpegPath,
		args: options.args,
		outputSampleRate: options.outputSampleRate,
		id: options.id,
	});
}
