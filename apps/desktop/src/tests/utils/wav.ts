import { statSync, writeFileSync } from "node:fs";

/** Write a 1-second 48 kHz 16-bit mono sine as a standard PCM WAV — the Read WAV input for the render assertion. */
export function writeSineWav(filePath: string): void {
	const sampleRate = 48000;
	const seconds = 1;
	const frequency = 440;
	const numSamples = sampleRate * seconds;
	const bytesPerSample = 2;
	const dataSize = numSamples * bytesPerSample;
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
	buffer.writeUInt16LE(bytesPerSample, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);

	for (let index = 0; index < numSamples; index++) {
		const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.5;
		const clamped = Math.max(-1, Math.min(1, sample));

		buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * bytesPerSample);
	}

	writeFileSync(filePath, buffer);
}

export function fileSize(filePath: string): number {
	try {
		return statSync(filePath).size;
	} catch {
		return -1;
	}
}
