export function downmixToMono(samples: Array<Float32Array>): Float32Array {
	const channels = samples.length;
	const frames = samples[0]?.length ?? 0;
	const mono = new Float32Array(frames);

	if (channels === 0) return mono;

	const scale = 1 / channels;

	for (let ch = 0; ch < channels; ch++) {
		const channel = samples[ch] ?? new Float32Array(0);

		for (let index = 0; index < frames; index++) {
			mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) * scale;
		}
	}

	return mono;
}
