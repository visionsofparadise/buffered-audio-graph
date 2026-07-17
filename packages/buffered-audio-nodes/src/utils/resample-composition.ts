import type { StreamContext, StreamSetupContext } from "@buffered-audio/core";
import { ffmpeg, FfmpegStream } from "../transforms/ffmpeg";

export function createResampleComposition(options: {
	context: StreamSetupContext;
	streamContext: StreamContext;
	ffmpegPath: string;
	modelRate: number;
}): { upResample: FfmpegStream; downResample: FfmpegStream } | undefined {
	const edgeRate = options.context.sampleRate;

	if (edgeRate === options.modelRate) return undefined;

	const upResample = new FfmpegStream(
		ffmpeg({
			ffmpegPath: options.ffmpegPath,
			args: ["-af", `aresample=${options.modelRate}`],
			outputSampleRate: options.modelRate,
		}),
		options.streamContext,
	);

	const downResample = new FfmpegStream(
		ffmpeg({
			ffmpegPath: options.ffmpegPath,
			args: ["-af", `aresample=${edgeRate}`],
			outputSampleRate: edgeRate,
		}),
		options.streamContext,
	);

	upResample._setup(options.context);
	downResample._setup(options.context);

	return { upResample, downResample };
}
