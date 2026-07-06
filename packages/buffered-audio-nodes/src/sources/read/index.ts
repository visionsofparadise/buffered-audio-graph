import { extname } from "node:path";
import { ReadFfmpegNode } from "./ffmpeg";
import { ReadWavNode } from "./wav";

export function read(path: string, options?: { channels?: ReadonlyArray<number>; ffmpegPath?: string; ffprobePath?: string }): ReadWavNode | ReadFfmpegNode {
	const ext = extname(path).toLowerCase();

	if (ext === ".wav") {
		return new ReadWavNode({ path, channels: options?.channels });
	}

	if (!options?.ffmpegPath || !options.ffprobePath) {
		throw new Error(`Non-WAV file requires ffmpegPath and ffprobePath: "${path}"`);
	}

	return new ReadFfmpegNode({ path, channels: options.channels, ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath });
}
