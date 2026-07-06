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

export async function parseWavFormat(fh: FileHandle, path: string): Promise<WavFormat> {
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
			// JUNK chunk: reserved placeholder for a ds64 chunk in pre-allocated headers — skip.
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
