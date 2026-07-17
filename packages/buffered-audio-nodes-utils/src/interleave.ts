export function interleave(samples: Array<Float32Array>, frames: number, channels: number): Float32Array {
	const interleaved = new Float32Array(frames * channels);

	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			interleaved[frame * channels + channel] = samples[channel]?.[frame] ?? 0;
		}
	}

	return interleaved;
}

export function deinterleaveBuffer(buffer: Buffer, channels: number): Array<Float32Array> {
	const totalSamples = buffer.length / 4;
	const frames = Math.floor(totalSamples / channels);
	const result: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		result.push(new Float32Array(frames));
	}

	const view = new Float32Array(buffer.buffer, buffer.byteOffset, totalSamples);

	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			const channelArray = result[channel];
			const value = view[frame * channels + channel];

			if (channelArray && value !== undefined) {
				channelArray[frame] = value;
			}
		}
	}

	return result;
}
