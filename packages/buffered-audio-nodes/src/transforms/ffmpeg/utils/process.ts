export function buildInputArgs(sampleRate: number, channels: number): Array<string> {
	return ["-f", "f32le", "-ar", String(sampleRate), "-ac", String(channels), "-i", "pipe:0"];
}

export function buildOutputArgs(outputSampleRate: number, channels: number): Array<string> {
	return ["-f", "f32le", "-ar", String(outputSampleRate), "-ac", String(channels), "pipe:1"];
}
