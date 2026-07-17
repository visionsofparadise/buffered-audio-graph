export function replaceChannel(chunk: { readonly samples: Array<Float32Array> }, channelIndex: number, newData: Float32Array, channels: number): Array<Float32Array> {
	const frames = newData.length;
	const result: Array<Float32Array> = [];

	for (let writeCh = 0; writeCh < channels; writeCh++) {
		result.push(writeCh === channelIndex ? newData : (chunk.samples[writeCh] ?? new Float32Array(frames)));
	}

	return result;
}
