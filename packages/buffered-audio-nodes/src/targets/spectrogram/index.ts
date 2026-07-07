/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { BufferedTargetStream, TargetNode, type Block, type StreamContext, type TargetNodeProperties } from "@buffered-audio/core";
import { detectFftBackend, getFftAddon, createFftWorkspace, hanningWindow, type FftWorkspace } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { computeSpectrogramFrames } from "./utils/frames";
import { FREQUENCY_SCALE_BYTE, computeMelBandMappings, computeErbBandMappings, computeLogBandMappings } from "./utils/frequency";

export const schema = z.object({
	outputPath: z.string().default("").meta({ input: "file", mode: "save" }).describe("Output Path"),
	fftSize: z.number().min(256).max(8192).multipleOf(256).default(2048).describe("FFT Size"),
	hopSize: z.number().min(64).max(8192).multipleOf(64).default(512).describe("Hop Size"),
	fftwAddonPath: z.string().default("").meta({ input: "file", mode: "open", binary: "fftw-addon" }).describe("FFTW Addon"),
});

export type FrequencyScale = "linear" | "log" | "mel" | "erb";

export interface SpectrogramProperties extends z.infer<typeof schema>, TargetNodeProperties {
	readonly frequencyScale?: FrequencyScale;
	readonly numBands?: number;
	readonly minFrequency?: number;
	readonly maxFrequency?: number;
}

const HEADER_SIZE = 33;

interface BandMapping {
	readonly binStart: number;
	readonly binEnd: number;
	readonly weightStart: number;
	readonly weightEnd: number;
}

export class SpectrogramStream extends BufferedTargetStream<SpectrogramProperties> {
	private fileHandle?: FileHandle;
	private channels = 0;
	private linearBins = 0;
	private outputBins = 0;
	private numFrames = 0;
	private fileOffset = HEADER_SIZE;

	private windowCoefficients: Float32Array = new Float32Array(0);
	private workspace?: FftWorkspace;
	private addon: ReturnType<typeof getFftAddon> = null;
	private bandMappings?: ReadonlyArray<BandMapping>;
	private magnitudes: Float32Array = new Float32Array(0);

	private sampleBuffers: Array<Float32Array> = [];
	private sampleBufferOffset = 0;
	private sampleBufferCapacity = 0;

	private writeBuffer?: Buffer;
	private writeBufferOffset = 0;
	private writeBufferFileOffset = HEADER_SIZE;
	private readonly WRITE_BATCH_FRAMES = 1000;

	private initialized = false;

	override async _setup(input: ReadableStream<Block>, context: StreamContext): Promise<void> {
		this.linearBins = this.properties.fftSize / 2 + 1;
		this.windowCoefficients = hanningWindow(this.properties.fftSize);
		this.workspace = createFftWorkspace(this.properties.fftSize);

		const fftAddonOptions = { fftwPath: this.properties.fftwAddonPath || undefined };
		const fftBackend = detectFftBackend(context.executionProviders, fftAddonOptions);

		this.addon = getFftAddon(fftBackend, fftAddonOptions);
		this.magnitudes = new Float32Array(this.linearBins);
		this.numFrames = 0;
		this.fileOffset = HEADER_SIZE;
		this.sampleBufferOffset = 0;
		this.sampleBufferCapacity = this.properties.fftSize + (8 * 1024 * 1024) / 4;

		this.fileHandle = await open(this.properties.outputPath, "w");

		return super._setup(input, context);
	}

	private async initialize(chunk: Block): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;

		this.channels = chunk.samples.length;

		const scale = this.properties.frequencyScale ?? "log";
		const numBands = this.properties.numBands ?? 512;
		const minFreq = this.properties.minFrequency ?? 20;
		const maxFreq = this.properties.maxFrequency ?? chunk.sampleRate / 2;

		if (scale === "linear") {
			this.bandMappings = undefined;
			this.outputBins = this.linearBins;
		} else {
			const computeFn = scale === "mel" ? computeMelBandMappings : scale === "erb" ? computeErbBandMappings : computeLogBandMappings;

			this.bandMappings = computeFn(numBands, minFreq, maxFreq, chunk.sampleRate, this.properties.fftSize);
			this.outputBins = numBands;
		}

		this.sampleBuffers = [];
		for (let ch = 0; ch < this.channels; ch++) {
			this.sampleBuffers.push(new Float32Array(this.sampleBufferCapacity));
		}

		if (!this.fileHandle) return;

		const header = Buffer.alloc(HEADER_SIZE);

		header.writeUInt32LE(chunk.sampleRate, 0);
		header.writeUInt32LE(this.channels, 4);
		header.writeUInt32LE(this.properties.fftSize, 8);
		header.writeUInt32LE(this.properties.hopSize, 12);
		header.writeUInt32LE(0, 16);
		header.writeUInt32LE(this.outputBins, 20);
		header.writeUInt8(FREQUENCY_SCALE_BYTE[scale], 24);
		header.writeFloatLE(minFreq, 25);
		header.writeFloatLE(maxFreq, 29);

		await this.fileHandle.write(header, 0, HEADER_SIZE, 0);
	}

	override async _write(chunk: Block): Promise<void> {
		await this.initialize(chunk);

		const frames = chunk.samples[0]?.length ?? 0;

		if (this.sampleBufferOffset + frames > this.sampleBufferCapacity) {
			const newCapacity = Math.max(this.sampleBufferCapacity * 2, this.sampleBufferOffset + frames);

			for (let ch = 0; ch < this.channels; ch++) {
				const newBuf = new Float32Array(newCapacity);

				newBuf.set(this.sampleBuffers[ch]!.subarray(0, this.sampleBufferOffset));
				this.sampleBuffers[ch] = newBuf;
			}

			this.sampleBufferCapacity = newCapacity;
		}

		for (let ch = 0; ch < this.channels; ch++) {
			const src = chunk.samples[ch];

			if (!src) continue;
			this.sampleBuffers[ch]!.set(src, this.sampleBufferOffset);
		}

		this.sampleBufferOffset += frames;

		await this.processAccumulatedSamples(false);
	}

	override async _close(): Promise<void> {
		await this.processAccumulatedSamples(true);

		if (this.writeBuffer && this.writeBufferOffset > 0) {
			await this.fileHandle!.write(this.writeBuffer, 0, this.writeBufferOffset, this.writeBufferFileOffset);
			this.writeBufferOffset = 0;
		}

		this.writeBuffer = undefined;

		const header = Buffer.alloc(4);

		header.writeUInt32LE(this.numFrames, 0);

		await this.fileHandle!.write(header, 0, 4, 16);
		await this.fileHandle!.close();
		this.fileHandle = undefined;
	}

	private async processAccumulatedSamples(flush: boolean): Promise<void> {
		const { fftSize, hopSize } = this.properties;
		const { addon } = this;
		const halfSize = this.linearBins;
		const magScale = 2 / fftSize;

		if (flush && this.sampleBufferOffset > 0 && this.sampleBufferOffset < fftSize) {
			for (let ch = 0; ch < this.channels; ch++) {
				const buf = this.sampleBuffers[ch]!;

				buf.fill(0, this.sampleBufferOffset, fftSize);
			}

			this.sampleBufferOffset = fftSize;
		}

		if (this.sampleBufferOffset < fftSize) return;

		const batchFrames = Math.floor((this.sampleBufferOffset - fftSize) / hopSize) + 1;

		if (batchFrames === 0) return;

		const frameByteSize = this.outputBins * this.channels * 4;
		const batchBytes = this.WRITE_BATCH_FRAMES * frameByteSize;

		if (!this.writeBuffer) {
			this.writeBuffer = Buffer.alloc(batchBytes);
			this.writeBufferOffset = 0;
			this.writeBufferFileOffset = this.fileOffset;
		}

		for (let ch = 0; ch < this.channels; ch++) {
			const frames = computeSpectrogramFrames(
				this.sampleBuffers[ch]!,
				batchFrames,
				fftSize,
				hopSize,
				halfSize,
				magScale,
				this.outputBins,
				this.windowCoefficients,
				this.workspace,
				addon,
				this.bandMappings,
				this.magnitudes,
			);

			for (const frame of frames) {
				await this.writeFrame(ch, frame);
			}
		}

		await this.flushWriteBuffer();

		const keepFrom = batchFrames * hopSize;
		const keepCount = this.sampleBufferOffset - keepFrom;

		if (keepCount > 0) {
			for (let ch = 0; ch < this.channels; ch++) {
				const buf = this.sampleBuffers[ch]!;

				buf.copyWithin(0, keepFrom, keepFrom + keepCount);
			}
		}

		this.sampleBufferOffset = keepCount > 0 ? keepCount : 0;
	}

	private async writeFrame(ch: number, frame: Float32Array): Promise<void> {
		const frameByteSize = this.outputBins * this.channels * 4;

		if (this.writeBuffer && this.writeBufferOffset + frameByteSize > this.writeBuffer.length) {
			await this.flushWriteBuffer();
		}

		const buf = this.writeBuffer;

		if (!buf) return;
		const offset = this.writeBufferOffset;

		for (let bin = 0; bin < this.outputBins; bin++) {
			buf.writeFloatLE(frame[bin]!, offset + (ch * this.outputBins + bin) * 4);
		}

		this.writeBufferOffset += frameByteSize;
		this.fileOffset += frameByteSize;
		this.numFrames++;
	}

	private async flushWriteBuffer(): Promise<void> {
		if (!this.writeBuffer || this.writeBufferOffset === 0) return;

		await this.fileHandle!.write(this.writeBuffer, 0, this.writeBufferOffset, this.writeBufferFileOffset);
		this.writeBufferFileOffset += this.writeBufferOffset;
		this.writeBufferOffset = 0;
	}
}

export class SpectrogramNode extends TargetNode<SpectrogramProperties> {
	static override readonly nodeName = "Spectrogram";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Generate spectrogram visualization data";
	static override readonly schema = schema;
	static override readonly streamClass = SpectrogramStream;

	static override is(value: unknown): value is SpectrogramNode {
		return TargetNode.is(value) && value.type[2] === "spectrogram";
	}

	override readonly type = ["buffered-audio-node", "target", "spectrogram"] as const;

	override clone(overrides?: Partial<SpectrogramProperties>): SpectrogramNode {
		return new SpectrogramNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function spectrogram(
	outputPath: string,
	options?: {
		fftSize?: number;
		hopSize?: number;
		frequencyScale?: FrequencyScale;
		numBands?: number;
		minFrequency?: number;
		maxFrequency?: number;
		fftwAddonPath?: string;
	},
): SpectrogramNode {
	return new SpectrogramNode({ outputPath, ...options });
}
