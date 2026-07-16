// Loudness-range gating and percentile selection follow EBU Tech 3342 v3.0.
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -20;
const LOW_PERCENTILE = 0.1;
const HIGH_PERCENTILE = 0.95;

export interface LraConsideredStats {
	readonly min: number;
	readonly median: number;
}

function getConsideredLoudness(shortTerm: ReadonlyArray<number>): Array<number> {
	const absoluteGated: Array<number> = [];

	for (let index = 0; index < shortTerm.length; index++) {
		const value = shortTerm[index] ?? 0;

		if (value >= ABSOLUTE_GATE_LUFS) absoluteGated.push(value);
	}

	if (absoluteGated.length === 0) return [];

	let absoluteSum = 0;

	for (let index = 0; index < absoluteGated.length; index++) {
		absoluteSum += Math.pow(10, (absoluteGated[index] ?? 0) / 10);
	}

	const relativeThreshold = 10 * Math.log10(absoluteSum / absoluteGated.length) + RELATIVE_GATE_OFFSET_LU;
	const considered: Array<number> = [];

	for (let index = 0; index < absoluteGated.length; index++) {
		const value = absoluteGated[index] ?? 0;

		if (value >= relativeThreshold) considered.push(value);
	}

	return considered;
}

export function computeLoudnessRange(shortTerm: ReadonlyArray<number>): number {
	const considered = getConsideredLoudness(shortTerm);

	if (considered.length < 2) return 0;

	considered.sort((left, right) => left - right);

	const lowIndex = Math.round((considered.length - 1) * LOW_PERCENTILE);
	const highIndex = Math.round((considered.length - 1) * HIGH_PERCENTILE);

	return (considered[highIndex] ?? 0) - (considered[lowIndex] ?? 0);
}

// Project-local loudness-target anchors over Tech 3342's gated set; min and median are not LRA metrics.
export function getLraConsideredStats(shortTerm: ReadonlyArray<number>): LraConsideredStats {
	const considered = getConsideredLoudness(shortTerm);

	if (considered.length === 0) {
		return { min: Number.POSITIVE_INFINITY, median: Number.POSITIVE_INFINITY };
	}

	considered.sort((left, right) => left - right);

	const min = considered[0] ?? Number.POSITIVE_INFINITY;
	const middleIndex = considered.length >> 1;
	const median = considered.length % 2 === 1 ? (considered[middleIndex] ?? Number.POSITIVE_INFINITY) : ((considered[middleIndex - 1] ?? 0) + (considered[middleIndex] ?? 0)) / 2;

	return { min, median };
}

export function getLraConsideredMinLufs(shortTerm: ReadonlyArray<number>): number {
	return getLraConsideredStats(shortTerm).min;
}
