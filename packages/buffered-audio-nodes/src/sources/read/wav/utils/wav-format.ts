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

interface HeaderWalk {
	readonly format?: WavFormat;
	readonly needed: number;
}

function walkWavHeader(bytes: Buffer): HeaderWalk {
	if (bytes.length < 4) return { needed: 12 };

	const magic = bytes.toString("latin1", 0, 4);

	if (magic !== "RIFF" && magic !== "RF64") throw new NotWavError(`Not a WAV stream (first bytes "${magic}")`);

	if (bytes.length < 12) return { needed: 12 };

	if (bytes.toString("latin1", 8, 12) !== "WAVE") throw new NotWavError(`Not a WAV stream (first bytes "${magic}")`);

	const isRf64 = magic === "RF64";
	let ds64DataSize: number | undefined;
	let format: WavFormat | undefined;
	let offset = 12;

	while (offset + 8 <= bytes.length) {
		const chunkId = bytes.toString("latin1", offset, offset + 4);
		const chunkSize = bytes.readUInt32LE(offset + 4);
		const bodyStart = offset + 8;

		if (chunkId === "data") {
			if (!format) throw new Error("WAV file has data chunk before fmt chunk");

			const dataSize = isRf64 && ds64DataSize !== undefined ? ds64DataSize : chunkSize;

			return { format: { ...format, dataOffset: bodyStart, dataSize }, needed: bodyStart };
		}

		if (chunkId === "ds64") {
			if (bytes.length < bodyStart + 16) return { needed: bodyStart + 16 };

			ds64DataSize = Number(bytes.readBigUInt64LE(bodyStart + 8));
		} else if (chunkId === "fmt ") {
			if (chunkSize < 16) throw new Error("WAV fmt chunk too small");

			if (bytes.length < bodyStart + chunkSize) return { needed: bodyStart + chunkSize };

			format = readFmtChunk(bytes.subarray(bodyStart, bodyStart + chunkSize));
		}

		offset = bodyStart + chunkSize + (chunkSize % 2);
	}

	return { needed: offset + 8 };
}

export function parseWavHeader(bytes: Buffer): WavFormat | undefined {
	return walkWavHeader(bytes).format;
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
	let bytes = Buffer.alloc(0);
	let readSize = HEADER_READ_SIZE;
	let needed = 12;

	while (needed <= fileSize) {
		const chunk = Buffer.alloc(Math.min(fileSize, Math.max(needed, bytes.length + readSize)) - bytes.length);
		const { bytesRead } = await fh.read(chunk, 0, chunk.length, bytes.length);

		if (bytesRead === 0) break;

		bytes = Buffer.concat([bytes, chunk.subarray(0, bytesRead)]);
		readSize *= 2;

		let walk: HeaderWalk;

		try {
			walk = walkWavHeader(bytes);
		} catch (error) {
			if (error instanceof NotWavError) throw new Error(`Not a WAV file: "${path}"`);

			throw error;
		}

		if (walk.format) return walk.format;

		needed = walk.needed;
	}

	if (bytes.length < 12) throw new Error(`Not a WAV file: "${path}"`);

	throw new Error(`Invalid WAV file: "${path}"`);
}
