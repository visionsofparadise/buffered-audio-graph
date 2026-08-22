export interface SpeechSegment {
	readonly start: number;
	readonly end: number;
}

export function probabilitiesToSegments(
	probabilities: Float32Array,
	options: {
		readonly threshold: number;
		readonly minSpeechFrames: number;
		readonly minSilenceFrames: number;
		readonly windowFrames: number;
		readonly totalFrames: number;
	},
): Array<SpeechSegment> {
	const { threshold, minSpeechFrames, minSilenceFrames, windowFrames, totalFrames } = options;
	const negativeThreshold = Math.max(threshold - 0.15, 0.01);
	const speeches: Array<SpeechSegment> = [];
	let triggered = false;
	let speechStart = 0;
	let silenceStart: number | undefined;

	for (let windowIndex = 0; windowIndex < probabilities.length; windowIndex++) {
		const speechProbability = probabilities[windowIndex] ?? 0;
		const currentSample = windowFrames * windowIndex;

		if (speechProbability >= threshold && silenceStart !== undefined) {
			silenceStart = undefined;
		}

		if (speechProbability >= threshold && !triggered) {
			triggered = true;
			speechStart = currentSample;

			continue;
		}

		if (speechProbability < negativeThreshold && triggered) {
			silenceStart ??= currentSample;

			if (currentSample - silenceStart < minSilenceFrames) {
				continue;
			}

			const speechEnd = silenceStart;

			if (speechEnd - speechStart > minSpeechFrames) {
				speeches.push({ start: speechStart, end: speechEnd });
			}

			speechStart = 0;
			silenceStart = undefined;
			triggered = false;

			continue;
		}
	}

	if (triggered && totalFrames - speechStart > minSpeechFrames) {
		speeches.push({ start: speechStart, end: totalFrames });
	}

	return speeches;
}

export function padSegments(
	segments: ReadonlyArray<SpeechSegment>,
	padFrames: number,
	totalFrames: number,
): Array<SpeechSegment> {
	const padded: Array<{ start: number; end: number }> = [];

	for (const segment of segments) {
		padded.push({ start: segment.start, end: segment.end });
	}

	const lastIndex = padded.length - 1;

	for (let segmentIndex = 0; segmentIndex < padded.length; segmentIndex++) {
		const speech = padded[segmentIndex];

		if (speech === undefined) continue;

		if (segmentIndex === 0) {
			speech.start = Math.max(0, speech.start - padFrames);
		}

		if (segmentIndex !== lastIndex) {
			const nextSpeech = padded[segmentIndex + 1];

			if (nextSpeech === undefined) continue;

			const silence = nextSpeech.start - speech.end;

			if (silence < 2 * padFrames) {
				const halfSilence = Math.floor(silence / 2);

				speech.end += halfSilence;
				nextSpeech.start = Math.max(0, nextSpeech.start - halfSilence);
			} else {
				speech.end = Math.min(totalFrames, speech.end + padFrames);
				nextSpeech.start = Math.max(0, nextSpeech.start - padFrames);
			}
		} else {
			speech.end = Math.min(totalFrames, speech.end + padFrames);
		}
	}

	return padded;
}

export function mapSegmentsToRate(
	segments: ReadonlyArray<SpeechSegment>,
	fromRate: number,
	toRate: number,
	totalFrames: number,
): Array<SpeechSegment> {
	const mapped: Array<SpeechSegment> = [];

	for (const segment of segments) {
		const start = Math.min(totalFrames, Math.max(0, Math.round((segment.start * toRate) / fromRate)));
		const end = Math.min(totalFrames, Math.max(0, Math.round((segment.end * toRate) / fromRate)));

		if (end > start) mapped.push({ start, end });
	}

	return mapped;
}
