import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { BufferedSourceStream, SourceNode, type Block, type SourceMetadata, type SourceNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME } from "../../../package-metadata";
import { DEFAULT_CHUNK_SIZE, parseWavFormat, readSample, type WavFormat } from "./utils/wav-format";

export const wavSchema = z.object({
	path: z.string().default("").meta({ input: "file", mode: "open" }),
});

export interface ReadWavProperties extends z.infer<typeof wavSchema>, SourceNodeProperties {
	readonly channels?: ReadonlyArray<number>;
}

export class ReadWavStream extends BufferedSourceStream<ReadWavNode> {
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

	override async _read(): Promise<Block | undefined> {
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

	override async _destroy(): Promise<void> {
		if (this.fileHandle) {
			await this.fileHandle.close().catch(() => undefined);
			this.fileHandle = undefined;
		}
	}
}

export class ReadWavNode extends SourceNode<ReadWavProperties> {
	static override readonly nodeName = "Read WAV";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Read audio from a WAV file";
	static override readonly schema = wavSchema;
	static override readonly Stream = ReadWavStream;
}

export function readWav(path: string, options?: { channels?: ReadonlyArray<number> }): ReadWavNode {
	return new ReadWavNode({ path, channels: options?.channels });
}
