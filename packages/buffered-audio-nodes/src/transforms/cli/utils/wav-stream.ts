import { decodeWavFrames, parseWavHeader, type WavFormat } from "../../../sources/read/wav/utils/wav-format";
import { writeFmtAndDataChunks } from "../../../targets/write/utils/wav";

const UINT32_MAX = 0xffffffff;
const STREAMING_HEADER_SIZE = 44;

export function buildStreamingWavHeader(sampleRate: number, channels: number): Buffer {
	const header = Buffer.alloc(STREAMING_HEADER_SIZE);

	header.write("RIFF", 0);
	header.writeUInt32LE(UINT32_MAX, 4);
	header.write("WAVE", 8);

	writeFmtAndDataChunks(header, 12, sampleRate, channels, "32f", UINT32_MAX);

	return header;
}

export class WavStreamParser {
	private pending: Buffer = Buffer.alloc(0);
	private format?: WavFormat;
	private remaining = Infinity;
	private stash: Buffer = Buffer.alloc(0);

	push(bytes: Buffer): { readonly header?: WavFormat; readonly samples?: Array<Float32Array> } {
		if (this.format) return { samples: this.decode(this.format, bytes) };

		this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, bytes]) : bytes;

		const header = parseWavHeader(this.pending);

		if (!header) return {};

		if (header.blockAlign === 0) throw new Error("WAV stream declares a block align of 0");

		const data = this.pending.subarray(header.dataOffset);

		this.format = header;
		this.pending = Buffer.alloc(0);
		this.remaining = header.dataSize === 0 || header.dataSize === UINT32_MAX ? Infinity : header.dataSize;

		return { header, samples: this.decode(header, data) };
	}

	end(): Array<Float32Array> | undefined {
		if (!this.format) throw new Error("WAV stream ended before its header completed");

		this.stash = Buffer.alloc(0);

		return undefined;
	}

	private decode(format: WavFormat, bytes: Buffer): Array<Float32Array> | undefined {
		const take = Math.min(bytes.length, this.remaining);

		this.remaining -= take;

		const merged =
			this.stash.length > 0 ? Buffer.concat([this.stash, bytes.subarray(0, take)]) : bytes.subarray(0, take);
		const frames = Math.floor(merged.length / format.blockAlign);

		this.stash = Buffer.from(merged.subarray(frames * format.blockAlign));

		if (frames === 0) return undefined;

		return decodeWavFrames(merged, format, frames);
	}
}
