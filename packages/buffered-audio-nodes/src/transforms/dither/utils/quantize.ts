export function quantizationLevels(bitDepth: number): number {
	return Math.pow(2, bitDepth - 1);
}

export function quantizeSample(value: number, levels: number): number {
	return Math.round(value * levels) / levels;
}
