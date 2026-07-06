import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { BufferedTargetStream, TargetNode, WHOLE_FILE, type Block, type StreamContext, type TargetNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { updateMinMax, writeMinMaxPoint } from "./utils/minmax";

export const schema = z.object({
	outputPath: z.string().default("").meta({ input: "file", mode: "save" }).describe("Output Path"),
	resolution: z.number().min(100).max(10000).multipleOf(100).default(1000).describe("Resolution"),
});

export interface WaveformProperties extends z.infer<typeof schema>, TargetNodeProperties {}

const HEADER_SIZE = 16;

export class WaveformStream extends BufferedTargetStream<WaveformProperties> {
	private fileHandle?: FileHandle;
	private channels = 0;
	private samplesPerPoint = 1;
	private totalPoints = 0;
	private fileOffset = HEADER_SIZE;

	private samplesInCurrentWindow = 0;
	private currentMin: Float32Array = new Float32Array(0);
	private currentMax: Float32Array = new Float32Array(0);

	private writeBuffer: Buffer = Buffer.alloc(0);
	private writeBufferOffset = 0;
	private writeBufferFileOffset = HEADER_SIZE;
	private readonly WRITE_BATCH_POINTS = 1000;

	private initialized = false;

	override async _setup(input: ReadableStream<Block>, context: StreamContext): Promise<void> {
		this.writeBufferOffset = 0;
		this.writeBufferFileOffset = HEADER_SIZE;
		this.totalPoints = 0;
		this.fileOffset = HEADER_SIZE;
		this.samplesInCurrentWindow = 0;

		this.fileHandle = await open(this.properties.outputPath, "w");

		return super._setup(input, context);
	}

	private initialize(chunk: Block): void {
		if (this.initialized) return;

		this.initialized = true;

		this.channels = chunk.samples.length;
		this.samplesPerPoint = Math.max(1, Math.round(chunk.sampleRate / this.properties.resolution));
		this.currentMin = new Float32Array(this.channels).fill(1);
		this.currentMax = new Float32Array(this.channels).fill(-1);

		const pointByteSize = this.channels * 8;

		this.writeBuffer = Buffer.alloc(this.WRITE_BATCH_POINTS * pointByteSize);
	}

	private async writeHeader(chunk: Block): Promise<void> {
		if (!this.fileHandle) return;

		const header = Buffer.alloc(HEADER_SIZE);

		header.writeUInt32LE(chunk.sampleRate, 0);
		header.writeUInt32LE(this.channels, 4);
		header.writeUInt32LE(this.properties.resolution, 8);
		header.writeUInt32LE(0, 12);

		await this.fileHandle.write(header, 0, HEADER_SIZE, 0);
	}

	override async _write(chunk: Block): Promise<void> {
		if (!this.initialized) {
			this.initialize(chunk);

			await this.writeHeader(chunk);
		}

		const frames = chunk.samples[0]?.length ?? 0;

		for (let frame = 0; frame < frames; frame++) {
			updateMinMax(chunk.samples, frame, this.channels, this.currentMin, this.currentMax);

			this.samplesInCurrentWindow++;

			if (this.samplesInCurrentWindow >= this.samplesPerPoint) {
				await this.flushPoint();
			}
		}
	}

	override async _close(): Promise<void> {
		if (this.samplesInCurrentWindow > 0) {
			await this.flushPoint();
		}

		const fh = this.fileHandle;

		if (!fh) return;

		if (this.writeBufferOffset > 0) {
			await fh.write(this.writeBuffer, 0, this.writeBufferOffset, this.writeBufferFileOffset);

			this.writeBufferOffset = 0;
		}

		const header = Buffer.alloc(4);

		header.writeUInt32LE(this.totalPoints, 0);

		await fh.write(header, 0, 4, 12);
		await fh.close();

		this.fileHandle = undefined;
	}

	private async flushPoint(): Promise<void> {
		const pointByteSize = this.channels * 8;

		if (this.writeBufferOffset + pointByteSize > this.writeBuffer.length) {
			await this.flushWriteBuffer();
		}

		writeMinMaxPoint(this.currentMin, this.currentMax, this.channels, this.writeBuffer, this.writeBufferOffset);

		this.writeBufferOffset += pointByteSize;
		this.fileOffset += pointByteSize;
		this.totalPoints++;

		this.samplesInCurrentWindow = 0;
		this.currentMin.fill(1);
		this.currentMax.fill(-1);
	}

	private async flushWriteBuffer(): Promise<void> {
		if (this.writeBufferOffset === 0 || !this.fileHandle) return;

		await this.fileHandle.write(this.writeBuffer, 0, this.writeBufferOffset, this.writeBufferFileOffset);
		this.writeBufferFileOffset += this.writeBufferOffset;
		this.writeBufferOffset = 0;
	}
}

export class WaveformNode extends TargetNode<WaveformProperties> {
	static override readonly nodeName = "Waveform";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Generate waveform visualization data";
	static override readonly schema = schema;

	static override is(value: unknown): value is WaveformNode {
		return TargetNode.is(value) && value.type[2] === "waveform";
	}

	override readonly type = ["buffered-audio-node", "target", "waveform"] as const;

	constructor(properties: WaveformProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): WaveformStream {
		return new WaveformStream(this.properties);
	}

	override clone(overrides?: Partial<WaveformProperties>): WaveformNode {
		return new WaveformNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function waveform(outputPath: string, options?: { resolution?: number }): WaveformNode {
	return new WaveformNode({
		outputPath,
		resolution: options?.resolution ?? 1000,
	});
}
