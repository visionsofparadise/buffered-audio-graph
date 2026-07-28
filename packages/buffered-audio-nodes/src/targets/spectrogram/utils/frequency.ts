import type { FrequencyScale } from "..";

interface BandMapping {
	readonly binStart: number;
	readonly binEnd: number;
	readonly weightStart: number;
	readonly weightEnd: number;
}

export const FREQUENCY_SCALE_BYTE: Record<FrequencyScale, number> = { linear: 0, log: 1, mel: 2, erb: 3 };

export function freqToMel(freq: number): number {
	return 2595 * Math.log10(1 + freq / 700);
}

export function melToFreq(mel: number): number {
	return 700 * (Math.pow(10, mel / 2595) - 1);
}

export function freqToErb(freq: number): number {
	return 21.4 * Math.log10(1 + 0.00437 * freq);
}

export function erbToFreq(erb: number): number {
	return (Math.pow(10, erb / 21.4) - 1) / 0.00437;
}

function computeScaledBandMappings(
	numBands: number,
	minFreq: number,
	maxFreq: number,
	sampleRate: number,
	fftSize: number,
	toScale: (f: number) => number,
	fromScale: (s: number) => number,
): ReadonlyArray<BandMapping> {
	const scaleMin = toScale(minFreq);
	const scaleMax = toScale(maxFreq);
	const scaleStep = (scaleMax - scaleMin) / numBands;
	const binWidth = sampleRate / fftSize;
	const numLinearBins = fftSize / 2 + 1;

	const mappings: Array<BandMapping> = [];

	for (let band = 0; band < numBands; band++) {
		const freqLow = fromScale(scaleMin + band * scaleStep);
		const freqHigh = fromScale(scaleMin + (band + 1) * scaleStep);

		const exactBinLow = freqLow / binWidth;
		const exactBinHigh = freqHigh / binWidth;

		const binStart = Math.max(0, Math.floor(exactBinLow));
		const binEnd = Math.min(numLinearBins - 1, Math.ceil(exactBinHigh));

		const weightStart = 1 - (exactBinLow - binStart);
		const weightEnd = 1 - (binEnd - exactBinHigh);

		mappings.push({
			binStart,
			binEnd: Math.max(binStart, binEnd),
			weightStart: Math.max(0, Math.min(1, weightStart)),
			weightEnd: Math.max(0, Math.min(1, weightEnd)),
		});
	}

	return mappings;
}

export function computeMelBandMappings(
	numBands: number,
	minFreq: number,
	maxFreq: number,
	sampleRate: number,
	fftSize: number,
): ReadonlyArray<BandMapping> {
	return computeScaledBandMappings(numBands, minFreq, maxFreq, sampleRate, fftSize, freqToMel, melToFreq);
}

export function computeErbBandMappings(
	numBands: number,
	minFreq: number,
	maxFreq: number,
	sampleRate: number,
	fftSize: number,
): ReadonlyArray<BandMapping> {
	return computeScaledBandMappings(numBands, minFreq, maxFreq, sampleRate, fftSize, freqToErb, erbToFreq);
}

export function computeLogBandMappings(
	numBands: number,
	minFreq: number,
	maxFreq: number,
	sampleRate: number,
	fftSize: number,
): ReadonlyArray<BandMapping> {
	return computeScaledBandMappings(numBands, minFreq, maxFreq, sampleRate, fftSize, Math.log, Math.exp);
}
