export interface ApplyBaseRateChunkArgs {
	chunkSamples: ReadonlyArray<Float32Array>;
	smoothedGain: Float32Array;
	// When supplied, each slot MUST be sized exactly to its channel's chunkSamples length (asserted).
	output?: Array<Float32Array>;
}

export function applyBaseRateChunk(args: ApplyBaseRateChunkArgs): Array<Float32Array> {
	const { chunkSamples, smoothedGain, output: outputOverride } = args;
	const channelCount = chunkSamples.length;

	if (channelCount === 0) return outputOverride ?? [];

	if (outputOverride !== undefined) {
		if (outputOverride.length !== channelCount) {
			throw new Error(
				`applyBaseRateChunk: output array length (${outputOverride.length}) must match channel count (${channelCount})`,
			);
		}

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const expected = chunkSamples[channelIndex]?.length ?? 0;
			const actual = outputOverride[channelIndex]?.length ?? -1;

			if (actual !== expected) {
				throw new Error(
					`applyBaseRateChunk: output[${channelIndex}] length (${actual}) must match chunkSamples[${channelIndex}] length (${expected})`,
				);
			}
		}
	}

	const output: Array<Float32Array> = outputOverride ?? [];

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		const channel = chunkSamples[channelIndex];

		if (channel === undefined || channel.length === 0) {
			if (outputOverride !== undefined) {
				output[channelIndex]?.fill(0);
			} else {
				output.push(new Float32Array(channel?.length ?? 0));
			}

			continue;
		}

		// Fail loud on a mis-sized envelope slice rather than silently zero-filling via the `?? 0` fallback.
		if (smoothedGain.length < channel.length) {
			throw new Error(
				`applyBaseRateChunk: smoothedGain length (${smoothedGain.length}) is shorter than chunk length (${channel.length}); caller must slice the envelope to match`,
			);
		}

		const chunkFrames = channel.length;
		const overrideSlot = outputOverride !== undefined ? outputOverride[channelIndex] : undefined;
		const slot = overrideSlot ?? new Float32Array(chunkFrames);

		for (let frameIdx = 0; frameIdx < chunkFrames; frameIdx++) {
			slot[frameIdx] = (channel[frameIdx] ?? 0) * (smoothedGain[frameIdx] ?? 0);
		}

		if (outputOverride === undefined) {
			output.push(slot);
		}
	}

	return output;
}
