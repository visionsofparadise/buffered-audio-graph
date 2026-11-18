import { stat, type FileHandle } from "node:fs/promises";

export const DEFAULT_CHUNK_SIZE = 44100;

export interface WavFormat {
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

const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const HEADER_READ_SIZE = 4096;
const MAX_HEADER_CHUNK_BYTES = 1024 * 1024;
const SUPPORTED_BITS: Partial<Record<number, ReadonlyArray<number>>> = { 1: [8, 16, 24, 32], 3: [32, 64] };

class NotWavError extends Error {}

function readFmtChunk(fmtData: Buffer): WavFormat {
	const declaredFormat = fmtData.readUInt16LE(0);
	const audioFormat =
		declaredFormat === WAVE_FORMAT_EXTENSIBLE && fmtData.length >= 26 ? fmtData.readUInt16LE(24) : declaredFormat;
	const bitsPerSample = fmtData.readUInt16LE(14);

	if (!SUPPORTED_BITS[audioFormat]?.includes(bitsPerSample)) {
		throw new Error(
			`Unsupported WAV format: format code ${audioFormat} at ${bitsPerSample} bits (supported: PCM 8, 16, 24 or 32 bits, IEEE float 32 or 64 bits)`,
		);
	}

	return {
		sampleRate: fmtData.readUInt32LE(4),
		channels: fmtData.readUInt16LE(2),
		bitsPerSample,
		audioFormat,
		blockAlign: fmtData.readUInt16LE(12),
		dataOffset: 0,
		dataSize: 0,
	};
}

export class WavHeaderReader {
	private pending: Buffer = Buffer.alloc(0);
	private position = 0;
	private skipBytes = 0;
	private started = false;
	private isRf64 = false;
	private ds64DataSize?: number;
	private format?: WavFormat;

	push(bytes: Buffer): { readonly format: WavFormat; readonly rest: Buffer } | undefined {
		let input = bytes;

		if (this.skipBytes > 0) {
			const skipped = Math.min(this.skipBytes, input.length);

			this.skipBytes -= skipped;
			this.position += skipped;
			input = input.subarray(skipped);

			if (input.length === 0) return undefined;
		}

		this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, input]) : input;

		return this.parse();
	}

	takeSkip(): number {
		const skipped = this.skipBytes;

		this.skipBytes = 0;
		this.position += skipped;

		return skipped;
	}

	private parse(): { readonly format: WavFormat; readonly rest: Buffer } | undefined {
		if (!this.started) {
			if (this.pending.length < 4) return undefined;

			const magic = this.pending.toString("latin1", 0, 4);

			if (magic !== "RIFF" && magic !== "RF64") throw new NotWavError(`Not a WAV stream (first bytes "${magic}")`);

			if (this.pending.length < 12) return undefined;

			if (this.pending.toString("latin1", 8, 12) !== "WAVE") {
				throw new NotWavError(`Not a WAV stream (first bytes "${magic}")`);
			}

			this.isRf64 = magic === "RF64";
			this.started = true;
			this.consume(12);
		}

		while (this.skipBytes === 0 && this.pending.length >= 8) {
			const chunkId = this.pending.toString("latin1", 0, 4);
			const chunkSize = this.pending.readUInt32LE(4);

			if (chunkId === "data") {
				if (!this.format) throw new Error("WAV file has data chunk before fmt chunk");

				const dataSize = this.isRf64 && this.ds64DataSize !== undefined ? this.ds64DataSize : chunkSize;
				const header = {
					format: { ...this.format, dataOffset: this.position + 8, dataSize },
					rest: this.pending.subarray(8),
				};

				this.pending = Buffer.alloc(0);

				return header;
			}

			if (chunkId === "fmt " || chunkId === "ds64") {
				if (chunkId === "fmt " && chunkSize < 16) throw new Error("WAV fmt chunk too small");

				const bodySize = chunkId === "ds64" ? 16 : chunkSize;

				if (bodySize > MAX_HEADER_CHUNK_BYTES) {
					throw new Error(
						`Invalid WAV stream: ${chunkId.trim()} chunk of ${chunkSize} bytes exceeds the 1 MiB header limit`,
					);
				}

				if (this.pending.length < 8 + bodySize) return undefined;

				const body = this.pending.subarray(8, 8 + bodySize);

				if (chunkId === "fmt ") this.format = readFmtChunk(body);
				else this.ds64DataSize = Number(body.readBigUInt64LE(8));
			}

			this.consume(8 + chunkSize + (chunkSize % 2));
		}

		this.pending = Buffer.from(this.pending);

		return undefined;
	}

	private consume(count: number): void {
		const available = Math.min(count, this.pending.length);

		this.pending = this.pending.subarray(available);
		this.position += available;
		this.skipBytes = count - available;
	}
}

export function parseWavHeader(bytes: Buffer): WavFormat | undefined {
	return new WavHeaderReader().push(bytes)?.format;
}

export function decodeWavFrames(data: Buffer, format: WavFormat, frames: number): Array<Float32Array> {
	const { channels, blockAlign, bitsPerSample, audioFormat } = format;
	const bytesPerSample = bitsPerSample / 8;
	const samples: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		samples.push(new Float32Array(frames));
	}

	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			const channelArray = samples[channel];

			if (channelArray) {
				channelArray[frame] = readSample(
					data,
					frame * blockAlign + channel * bytesPerSample,
					bitsPerSample,
					audioFormat,
				);
			}
		}
	}

	return samples;
}

export async function parseWavFormat(fh: FileHandle, path: string): Promise<WavFormat> {
	const fileSize = (await stat(path)).size;
	const reader = new WavHeaderReader();
	let position = 0;

	while (position < fileSize) {
		const chunk = Buffer.alloc(Math.min(HEADER_READ_SIZE, fileSize - position));
		const { bytesRead } = await fh.read(chunk, 0, chunk.length, position);

		if (bytesRead === 0) break;

		position += bytesRead;

		let header: { readonly format: WavFormat } | undefined;

		try {
			header = reader.push(chunk.subarray(0, bytesRead));
		} catch (error) {
			if (error instanceof NotWavError) throw new Error(`Not a WAV file: "${path}"`);

			throw error;
		}

		if (header) return header.format;

		position += reader.takeSkip();
	}

	if (position < 12) throw new Error(`Not a WAV file: "${path}"`);

	throw new Error(`Invalid WAV file: "${path}"`);
}
