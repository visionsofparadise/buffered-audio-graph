import { open, stat, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { BufferedSourceStream, SourceNode, type AudioChunk, type SourceMetadata, type SourceNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../../package-metadata";

export const wavSchema = z.object({
	path: z.string().default("").meta({ input: "file", mode: "open" }),
});

export interface ReadWavProperties extends z.infer<typeof wavSchema>, SourceNodeProperties {
	readonly channels?: ReadonlyArray<number>;
}

const DEFAULT_CHUNK_SIZE = 44100;

interface WavFormat {
	readonly sampleRate: number;
	readonly channels: number;
	readonly bitsPerSample: number;
	readonly audioFormat: number;
	readonly blockAlign: number;
	readonly dataOffset: number;
	readonly dataSize: number;
}

export function readSample(data: Buffer, offset: number, bitsPerSample: number, audioFormat: number): number {
	if (audioFormat === 3) {
		if (bitsPerSample === 32) return data.readFloatLE(offset);
		if (bitsPerSample === 64) return data.readDoubleLE(offset);
	}

	if (bitsPerSample === 16) return data.readInt16LE(offset) / 0x8000;
	if (bitsPerSample === 24) {
		const byte0 = data[offset] ?? 0;
		const byte1 = data[offset + 1] ?? 0;
		const byte2 = data[offset + 2] ?? 0;
		const raw = byte0 | (byte1 << 8) | (byte2 << 16);

		return (raw > 0x7fffff ? raw - 0x1000000 : raw) / 0x800000;
	}

	if (bitsPerSample === 32) return data.readInt32LE(offset) / 0x80000000;
	if (bitsPerSample === 8) return ((data[offset] ?? 128) - 128) / 128;

	return 0;
}

async function parseWavFormat(fh: FileHandle, path: string): Promise<WavFormat> {
	const fileInfo = await stat(path);

	const header = Buffer.alloc(12);

	await fh.read(header, 0, 12, 0);

	const magic = header.toString("ascii", 0, 4);
	const wave = header.toString("ascii", 8, 12);

	if ((magic !== "RIFF" && magic !== "RF64") || wave !== "WAVE") {
		throw new Error(`Not a WAV file: "${path}"`);
	}

	const isRf64 = magic === "RF64";
	let ds64DataSize: number | undefined;

	let offset = 12;
	const fileSize = fileInfo.size;
	let format: WavFormat | undefined;
	const chunkHeader = Buffer.alloc(8);

	while (offset < fileSize) {
		await fh.read(chunkHeader, 0, 8, offset);
		const chunkId = chunkHeader.toString("ascii", 0, 4);
		const chunkSize = chunkHeader.readUInt32LE(4);

		if (chunkId === "ds64") {
			const ds64Data = Buffer.alloc(Math.min(chunkSize, 28));

			await fh.read(ds64Data, 0, ds64Data.length, offset + 8);
			ds64DataSize = Number(ds64Data.readBigUInt64LE(8));
		} else if (chunkId === "JUNK") {
			// Skip JUNK chunks (placeholder for ds64 in pre-allocated headers)
		} else if (chunkId === "fmt ") {
			if (chunkSize < 16) throw new Error("WAV fmt chunk too small");
			const fmtData = Buffer.alloc(chunkSize);

			await fh.read(fmtData, 0, chunkSize, offset + 8);

			const audioFormat = fmtData.readUInt16LE(0);
			const channels = fmtData.readUInt16LE(2);
			const sampleRate = fmtData.readUInt32LE(4);
			const blockAlign = fmtData.readUInt16LE(12);
			const bitsPerSample = fmtData.readUInt16LE(14);

			format = { sampleRate, channels, bitsPerSample, audioFormat, blockAlign, dataOffset: 0, dataSize: 0 };
		} else if (chunkId === "data") {
			if (!format) throw new Error("WAV file has data chunk before fmt chunk");
			const dataSize = isRf64 && ds64DataSize !== undefined ? ds64DataSize : chunkSize;

			format = { ...format, dataOffset: offset + 8, dataSize };
			break;
		}

		offset += 8 + chunkSize;
		if (chunkSize % 2 !== 0) offset++;
	}

	if (!format || format.dataOffset === 0) {
		throw new Error(`Invalid WAV file: "${path}"`);
	}

	return format;
}

export class ReadWavStream<P extends ReadWavProperties = ReadWavProperties> extends BufferedSourceStream<P> {
	private fileHandle?: FileHandle;
	private format?: WavFormat;
	private bytesRead = 0;
	private sourceSampleRate = 0;
	private sourceBitDepth = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		const fh = await open(this.properties.path, "r");

		try {
			const format = await parseWavFormat(fh, this.properties.path);
			const selectedChannels = this.properties.channels;
			const outputChannels = selectedChannels ? selectedChannels.length : format.channels;
			const totalFrames = Math.floor(format.dataSize / format.blockAlign);

			return {
				sampleRate: format.sampleRate,
				channels: outputChannels,
				durationFrames: totalFrames,
			};
		} finally {
			await fh.close();
		}
	}

	private async ensureInitialized(): Promise<void> {
		if (this.format) return;

		this.fileHandle = await open(this.properties.path, "r");

		const format = await parseWavFormat(this.fileHandle, this.properties.path);

		this.format = format;
		this.bytesRead = 0;
		this.sourceSampleRate = format.sampleRate;
		this.sourceBitDepth = format.bitsPerSample;

	}

	override async _read(): Promise<AudioChunk | undefined> {
		await this.ensureInitialized();

		const fh = this.fileHandle;
		const format = this.format;

		if (!fh || !format) {
			return undefined;
		}

		const remaining = format.dataSize - this.bytesRead;

		if (remaining <= 0) {
			return undefined;
		}

		const framesWanted = DEFAULT_CHUNK_SIZE;
		const bytesWanted = Math.min(framesWanted * format.blockAlign, remaining);
		const chunk = Buffer.alloc(bytesWanted);
		const { bytesRead } = await fh.read(chunk, 0, bytesWanted, format.dataOffset + this.bytesRead);

		if (bytesRead === 0) {
			return undefined;
		}

		const frames = Math.floor(bytesRead / format.blockAlign);

		this.bytesRead += frames * format.blockAlign;

		const fileChannels = format.channels;
		const selectedChannels = this.properties.channels;

		const allChannels: Array<Float32Array> = [];

		for (let ch = 0; ch < fileChannels; ch++) {
			allChannels.push(new Float32Array(frames));
		}

		for (let frame = 0; frame < frames; frame++) {
			for (let ch = 0; ch < fileChannels; ch++) {
				const byteOffset = frame * format.blockAlign + ch * (format.bitsPerSample / 8);
				const channel = allChannels[ch];

				if (channel) {
					channel[frame] = readSample(chunk, byteOffset, format.bitsPerSample, format.audioFormat);
				}
			}
		}

		let samples: Array<Float32Array>;

		if (selectedChannels) {
			samples = selectedChannels.map((srcCh) => allChannels[srcCh] ?? new Float32Array(frames));
		} else {
			samples = allChannels;
		}

		const frameOffset = Math.floor((this.bytesRead - frames * format.blockAlign) / format.blockAlign);

		return {
			samples,
			offset: frameOffset,
			sampleRate: this.sourceSampleRate,
			bitDepth: this.sourceBitDepth,
		};
	}

	override async _flush(): Promise<void> {
		if (this.fileHandle) {
			await this.fileHandle.close();
			this.fileHandle = undefined;
		}
	}

	override _teardown(): void {
		if (this.fileHandle) {
			this.fileHandle.close().catch(() => undefined);
			this.fileHandle = undefined;
		}
	}
}

export class ReadWavNode extends SourceNode<ReadWavProperties> {
	static override readonly moduleName = "Read WAV";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Read audio from a WAV file";
	static override readonly schema = wavSchema;
	override readonly type = ["buffered-audio-node", "source", "read-wav"] as const;

	protected override createStream(): ReadWavStream {
		return new ReadWavStream(this.properties);
	}

	clone(overrides?: Partial<ReadWavProperties>): ReadWavNode {
		return new ReadWavNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function readWav(path: string, options?: { channels?: ReadonlyArray<number> }): ReadWavNode {
	return new ReadWavNode({ path, channels: options?.channels });
}
