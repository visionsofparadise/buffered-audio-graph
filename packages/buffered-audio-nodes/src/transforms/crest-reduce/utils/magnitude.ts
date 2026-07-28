export function argmaxMagnitude(samples: Float32Array): { magnitude: number; index: number } {
	let magnitude = 0;
	let index = 0;

	for (let position = 0; position < samples.length; position++) {
		const value = samples[position] ?? 0;
		const absolute = value < 0 ? -value : value;

		if (absolute > magnitude) {
			magnitude = absolute;
			index = position;
		}
	}

	return { magnitude, index };
}
