export function invertSamples(samples: Array<Float32Array>): Array<Float32Array> {
	return samples.map((channel) => {
		const output = new Float32Array(channel.length);

		for (let index = 0; index < channel.length; index++) {
			output[index] = -(channel[index] ?? 0);
		}

		return output;
	});
}

export function phaseCoefficient(angle: number): number {
	const radians = (angle * Math.PI) / 180;

	return Math.tan((radians - Math.PI) / 4);
}

export function applyAllpass(channel: Float32Array, coefficient: number, state: number): { output: Float32Array; state: number } {
	const output = new Float32Array(channel.length);

	for (let index = 0; index < channel.length; index++) {
		const input = channel[index] ?? 0;
		const allpassOut = coefficient * input + state;

		state = input - coefficient * allpassOut;
		output[index] = allpassOut;
	}

	return { output, state };
}
