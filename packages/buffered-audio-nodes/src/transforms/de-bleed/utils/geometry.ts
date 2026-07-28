
export interface ProcessGeometry {
	readonly edgePadSamples: number;
	readonly processStftFrames: number;
	readonly warmupFrames: number;
}

export function computeProcessGeometry(args: {
	readonly totalFrames: number;
	readonly fftSize: number;
	readonly hopSize: number;
	readonly sampleRate: number | undefined;
	readonly warmupSeconds: number;
}): ProcessGeometry {
	const { totalFrames, fftSize, hopSize, sampleRate, warmupSeconds } = args;

	const edgePadSamples = fftSize - hopSize;
	const virtualTotal = totalFrames + 2 * edgePadSamples;
	const virtualLogicalLength = Math.max(virtualTotal, fftSize);
	const virtualPaddedLength = virtualLogicalLength + ((hopSize - ((virtualLogicalLength - fftSize) % hopSize)) % hopSize);
	const processStftFrames = Math.floor((virtualPaddedLength - fftSize) / hopSize) + 1;

	const effectiveSampleRate = sampleRate ?? 48000;
	const warmupSamples = Math.min(warmupSeconds * effectiveSampleRate, totalFrames);
	const warmupFrames = Math.max(0, Math.floor((warmupSamples - fftSize) / hopSize) + 1);

	return { edgePadSamples, processStftFrames, warmupFrames };
}

export interface ChunkWindow {
	readonly outFramesThisChunk: number;
	readonly winStart: number;
	readonly winEnd: number;
	readonly winFrames: number;
	readonly winSamples: number;
}

export function computeChunkWindow(args: {
	readonly outStart: number;
	readonly chunkFrames: number;
	readonly processStftFrames: number;
	readonly carry: number;
	readonly fftSize: number;
	readonly hopSize: number;
}): ChunkWindow {
	const { outStart, chunkFrames, processStftFrames, carry, fftSize, hopSize } = args;

	const outFramesThisChunk = Math.min(chunkFrames, processStftFrames - outStart);
	const winStart = Math.max(0, outStart - carry);
	const winEnd = Math.min(processStftFrames, outStart + outFramesThisChunk + carry);
	const winFrames = winEnd - winStart;
	const winSamples = winFrames * hopSize + (fftSize - hopSize);

	return { outFramesThisChunk, winStart, winEnd, winFrames, winSamples };
}

export interface WriteClip {
	readonly clipStart: number;
	readonly sliceFromOffset: number;
	readonly sliceLength: number;
}

export function computeWriteClip(args: {
	readonly outStart: number;
	readonly winStart: number;
	readonly outFramesThisChunk: number;
	readonly processStftFrames: number;
	readonly hopSize: number;
	readonly edgePadSamples: number;
	readonly totalFrames: number;
	readonly cleanedLength: number;
}): WriteClip | undefined {
	const { outStart, winStart, outFramesThisChunk, processStftFrames, hopSize, edgePadSamples, totalFrames, cleanedLength } = args;

	const centerStartFrame = outStart - winStart;
	const centerStartSample = centerStartFrame * hopSize;
	const isFinalChunk = outStart + outFramesThisChunk >= processStftFrames;
	const centerEndSample = isFinalChunk ? cleanedLength : (centerStartFrame + outFramesThisChunk) * hopSize;
	const virtualWriteStart = winStart * hopSize + centerStartSample;
	const realWriteStart = virtualWriteStart - edgePadSamples;
	const realWriteEnd = realWriteStart + (centerEndSample - centerStartSample);
	const clipStart = Math.max(0, realWriteStart);
	const clipEnd = Math.min(totalFrames, realWriteEnd);

	if (clipEnd <= clipStart) return undefined;

	const sliceFromOffset = clipStart - realWriteStart + centerStartSample;
	const sliceLength = clipEnd - clipStart;

	return { clipStart, sliceFromOffset, sliceLength };
}
