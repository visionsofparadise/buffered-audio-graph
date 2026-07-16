/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight deinterleave loop with bounds-checked typed array access */
import type { Readable } from "node:stream";
import type { Block } from "../../block";

export function deinterleave(buffer: Buffer, channels: number): Array<Float32Array> {
	const bytesPerFrame = channels * 4;
	const frames = Math.floor(buffer.length / bytesPerFrame);
	const interleaved = new Float32Array(buffer.buffer, buffer.byteOffset, frames * channels);
	const samples: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) samples.push(new Float32Array(frames));

	for (let frame = 0; frame < frames; frame++) {
		const base = frame * channels;

		for (let channel = 0; channel < channels; channel++) samples[channel]![frame] = interleaved[base + channel]!;
	}

	return samples;
}

export function buildBlock(samples: Array<Float32Array>, offset: number, sampleRate?: number, bitDepth?: number): Block {
	return { samples, offset, sampleRate: sampleRate ?? 0, bitDepth: bitDepth ?? 0 };
}

export async function pullBytes(stream: Readable, isEnded: () => boolean, bytesNeeded: number): Promise<Buffer> {
	const chunks: Array<Buffer> = [];
	let collected = 0;

	while (collected < bytesNeeded) {
		const chunk = stream.read() as Buffer | null;

		if (chunk !== null) {
			const remaining = bytesNeeded - collected;

			if (chunk.length <= remaining) {
				chunks.push(chunk);
				collected += chunk.length;
			} else {
				chunks.push(chunk.subarray(0, remaining));
				collected += remaining;
				stream.unshift(chunk.subarray(remaining));
			}

			continue;
		}

		if (isEnded()) break;

		await new Promise<void>((resolve) => {
			const wake = (): void => {
				stream.off("readable", wake);
				stream.off("end", wake);
				stream.off("error", wake);
				stream.off("close", wake);
				resolve();
			};

			// Error and close must wake an in-flight read so stream failure settles instead of hanging.
			stream.once("readable", wake);
			stream.once("end", wake);
			stream.once("error", wake);
			stream.once("close", wake);
		});
	}

	if (chunks.length === 0) return Buffer.alloc(0);
	if (chunks.length === 1) return chunks[0]!;

	return Buffer.concat(chunks);
}
