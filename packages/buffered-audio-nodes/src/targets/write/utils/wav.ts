import type { WavBitDepth } from "..";

const UINT32_MAX = 0xffffffff;

export function getBytesPerSample(bitDepth: WavBitDepth): number {
	switch (bitDepth) {
		case "16":
			return 2;
		case "24":
			return 3;
		case "32":
		case "32f":
			return 4;
	}
}

export function writeSample(buffer: Buffer, offset: number, sample: number, bitDepth: WavBitDepth): number {
	switch (bitDepth) {
		case "16": {
			const clamped = Math.max(-1, Math.min(1, sample));
			const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

			buffer.writeInt16LE(Math.round(value), offset);

			return offset + 2;
		}

		case "24": {
			const clamped = Math.max(-1, Math.min(1, sample));
			const value = Math.round(clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff);

			buffer[offset] = value & 0xff;
			buffer[offset + 1] = (value >> 8) & 0xff;
			buffer[offset + 2] = (value >> 16) & 0xff;

			return offset + 3;
		}

		case "32": {
			const clamped = Math.max(-1, Math.min(1, sample));
			const value = clamped < 0 ? clamped * 0x80000000 : clamped * 0x7fffffff;

			buffer.writeInt32LE(Math.round(value), offset);

			return offset + 4;
		}

		case "32f": {
			buffer.writeFloatLE(sample, offset);

			return offset + 4;
		}
	}
}

export function writeFmtAndDataChunks(
	header: Buffer,
	offset: number,
	sampleRate: number,
	channels: number,
	bitDepth: WavBitDepth,
	dataSize: number,
): void {
	const bytesPerSample = getBytesPerSample(bitDepth);
	const blockAlign = channels * bytesPerSample;
	const byteRate = sampleRate * blockAlign;
	const bitsPerSample = bytesPerSample * 8;
	const audioFormat = bitDepth === "32f" ? 3 : 1;

	header.write("fmt ", offset);
	header.writeUInt32LE(16, offset + 4);
	header.writeUInt16LE(audioFormat, offset + 8);
	header.writeUInt16LE(channels, offset + 10);
	header.writeUInt32LE(sampleRate, offset + 12);
	header.writeUInt32LE(byteRate, offset + 16);
	header.writeUInt16LE(blockAlign, offset + 20);
	header.writeUInt16LE(bitsPerSample, offset + 22);
	header.write("data", offset + 24);
	header.writeUInt32LE(dataSize, offset + 28);
}

export function buildWavHeader(dataSize: number, sampleRate: number, channels: number, bitDepth: WavBitDepth): Buffer {
	const WAV_HEADER_SIZE = 80;
	const header = Buffer.alloc(WAV_HEADER_SIZE);

	header.write("RIFF", 0);
	header.writeUInt32LE(WAV_HEADER_SIZE - 8 + dataSize, 4);
	header.write("WAVE", 8);
	header.write("JUNK", 12);
	header.writeUInt32LE(28, 16);

	writeFmtAndDataChunks(header, 48, sampleRate, channels, bitDepth, dataSize);

	return header;
}

export function buildRf64Header(dataSize: number, sampleRate: number, channels: number, bitDepth: WavBitDepth): Buffer {
	const WAV_HEADER_SIZE = 80;
	const header = Buffer.alloc(WAV_HEADER_SIZE);
	const bytesPerSample = getBytesPerSample(bitDepth);
	const blockAlign = channels * bytesPerSample;
	const sampleCount = Math.floor(dataSize / blockAlign);

	header.write("RF64", 0);
	header.writeUInt32LE(UINT32_MAX, 4);
	header.write("WAVE", 8);
	header.write("ds64", 12);
	header.writeUInt32LE(28, 16);
	writeBigUInt64LE(header, 20, WAV_HEADER_SIZE - 8 + dataSize);
	writeBigUInt64LE(header, 28, dataSize);
	writeBigUInt64LE(header, 36, sampleCount);
	header.writeUInt32LE(0, 44);

	writeFmtAndDataChunks(header, 48, sampleRate, channels, bitDepth, UINT32_MAX);

	return header;
}

export function writeBigUInt64LE(buffer: Buffer, offset: number, value: number): void {
	buffer.writeBigUInt64LE(BigInt(Math.floor(value)), offset);
}
