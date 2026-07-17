export function updateMinMax(
	samples: ReadonlyArray<Float32Array>,
	frame: number,
	channels: number,
	min: Float32Array,
	max: Float32Array,
): void {
	for (let channel = 0; channel < channels; channel++) {
		const sample = samples[channel]?.[frame] ?? 0;
		const currentMin = min[channel];
		const currentMax = max[channel];

		if (currentMin !== undefined && sample < currentMin) min[channel] = sample;
		if (currentMax !== undefined && sample > currentMax) max[channel] = sample;
	}
}

export function writeMinMaxPoint(
	min: Float32Array,
	max: Float32Array,
	channels: number,
	target: Buffer,
	offset: number,
): void {
	for (let channel = 0; channel < channels; channel++) {
		target.writeFloatLE(min[channel] ?? 0, offset + channel * 8);
		target.writeFloatLE(max[channel] ?? 0, offset + channel * 8 + 4);
	}
}
