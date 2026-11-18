import { deinterleaveBuffer, interleave } from "@buffered-audio/utils";
import { decodeWavFrames, type WavFormat } from "../../../sources/read/wav/utils/wav-format";

export type PcmFormat = "f32le" | "f64le";

function bytesPerSample(format: PcmFormat): number {
	return format === "f64le" ? 8 : 4;
}

export function encodePcm(samples: Array<Float32Array>, frames: number, format: PcmFormat): Buffer {
	const channels = samples.length;

	if (format === "f32le") {
		const interleaved = interleave(samples, frames, channels);

		return Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
	}

	const buffer = Buffer.allocUnsafe(frames * channels * 8);

	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			buffer.writeDoubleLE(samples[channel]?.[frame] ?? 0, (frame * channels + channel) * 8);
		}
	}

	return buffer;
}

function decodeFloat64(bytes: Buffer, channels: number, frames: number): Array<Float32Array> {
	const format: WavFormat = {
		sampleRate: 0,
		channels,
		bitsPerSample: 64,
		audioFormat: 3,
		blockAlign: channels * 8,
		dataOffset: 0,
		dataSize: bytes.length,
	};

	return decodeWavFrames(bytes, format, frames);
}

export class PcmStreamDecoder {
	private readonly channels: number;
	private readonly format: PcmFormat;
	private stash: Buffer = Buffer.alloc(0);

	constructor(channels: number, format: PcmFormat) {
		this.channels = channels;
		this.format = format;
	}

	push(bytes: Buffer): Array<Float32Array> | undefined {
		const merged = this.stash.length > 0 ? Buffer.concat([this.stash, bytes]) : bytes;
		const sampleBytes = bytesPerSample(this.format);
		const frameBytes = this.channels * sampleBytes;

		if (frameBytes === 0) return undefined;

		const frames = Math.floor(merged.length / frameBytes);
		const completeBytes = frames * frameBytes;

		this.stash = Buffer.from(merged.subarray(completeBytes));

		if (frames === 0) return undefined;

		if (this.format === "f64le") return decodeFloat64(merged, this.channels, frames);

		const aligned =
			merged.byteOffset % sampleBytes === 0
				? merged.subarray(0, completeBytes)
				: Buffer.from(merged.subarray(0, completeBytes));

		return deinterleaveBuffer(aligned, this.channels);
	}

	end(): Array<Float32Array> | undefined {
		this.stash = Buffer.alloc(0);

		return undefined;
	}
}
