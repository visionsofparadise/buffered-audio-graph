export function smoothEnvelope(envelope: Float32Array, windowSize: number, scratch?: Float32Array): void {
	const halfWin = Math.floor(windowSize / 2);
	const envelopeLength = envelope.length;

	const source = scratch ?? Float32Array.from(envelope);

	if (scratch) {
		source.set(envelope);
	}

	let sum = 0;
	let count = 0;

	for (let index = 0; index < Math.min(halfWin, envelopeLength); index++) {
		sum += source[index] ?? 0;
		count++;
	}

	for (let index = 0; index < envelopeLength; index++) {
		const addIdx = index + halfWin;

		if (addIdx < envelopeLength) {
			sum += source[addIdx] ?? 0;
			count++;
		}

		const removeIdx = index - halfWin - 1;

		if (removeIdx >= 0) {
			sum -= source[removeIdx] ?? 0;
			count--;
		}

		envelope[index] = sum / Math.max(count, 1);
	}
}
