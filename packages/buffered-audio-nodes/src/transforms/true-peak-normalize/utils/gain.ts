export function resolveTruePeakGain(sourcePeakLinear: number, target: number): { gain: number; sourceTpDb: number } {
	if (sourcePeakLinear <= 0) return { gain: 1, sourceTpDb: -Infinity };

	const sourceTpDb = 20 * Math.log10(sourcePeakLinear);

	return { gain: Math.pow(10, (target - sourceTpDb) / 20), sourceTpDb };
}
