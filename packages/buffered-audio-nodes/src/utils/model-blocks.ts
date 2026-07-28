import type { BlockBuffer } from "@buffered-audio/core";

export async function pullModelChunk(args: {
	readonly buffer: BlockBuffer;
	readonly channels: number;
	readonly frames: number;
}): Promise<ReadonlyArray<Float32Array> | undefined> {
	const { buffer, channels, frames } = args;
	const chunk = await buffer.read(frames);
	const got = chunk.samples[0]?.length ?? 0;

	if (got === 0) return undefined;

	const out: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		out.push(chunk.samples[channel] ?? chunk.samples[0] ?? new Float32Array(got));
	}

	return out;
}

export function buildWriteChannels(left: Float32Array, right: Float32Array, channels: number): Array<Float32Array> {
	const out: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		if (channel === 0) out.push(left);
		else if (channel === 1) out.push(right);
		else out.push(left);
	}

	return out;
}

export class BoundedWriter {
	private written = 0;

	private readonly output: BlockBuffer;
	private readonly sampleRate: number;
	private readonly bitDepth: number | undefined;
	private readonly totalFrames: number;

	constructor(args: {
		readonly output: BlockBuffer;
		readonly sampleRate: number;
		readonly bitDepth: number | undefined;
		readonly totalFrames: number;
	}) {
		this.output = args.output;
		this.sampleRate = args.sampleRate;
		this.bitDepth = args.bitDepth;
		this.totalFrames = args.totalFrames;
	}

	async write(channels: Array<Float32Array>, frames: number): Promise<void> {
		const remaining = Math.max(0, this.totalFrames - this.written);

		if (remaining === 0) return;

		const take = Math.min(frames, remaining);
		const writeChannels = take === frames ? channels : channels.map((channel) => channel.subarray(0, take));

		await this.output.write(writeChannels, this.sampleRate, this.bitDepth);
		this.written += take;
	}

	async padTail(channels: number): Promise<void> {
		if (this.written >= this.totalFrames) return;

		const missing = this.totalFrames - this.written;
		const padChannels: Array<Float32Array> = [];

		for (let channel = 0; channel < Math.max(1, channels); channel++) {
			padChannels.push(new Float32Array(missing));
		}

		await this.output.write(padChannels, this.sampleRate, this.bitDepth);
	}
}
