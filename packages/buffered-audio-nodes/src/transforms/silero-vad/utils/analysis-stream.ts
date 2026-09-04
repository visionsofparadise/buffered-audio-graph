import { toReadable, type Block, type StreamContext, type StreamSetupContext } from "@buffered-audio/core";
import { downmixToMono } from "../../../utils/mix";
import { ffmpeg, FfmpegStream } from "../../ffmpeg";

const VAD_SAMPLE_RATE = 16000;

export function createAnalysisStream(options: {
	readonly blocks: AsyncIterable<Block>;
	readonly ffmpegPath: string;
	readonly streamContext: StreamContext;
	readonly setupContext: StreamSetupContext;
}): ReadableStream<Block> {
	const monoStream = toReadable(downmixBlocks(options.blocks));

	if (options.setupContext.sampleRate === VAD_SAMPLE_RATE) return monoStream;

	const resample = new FfmpegStream(
		ffmpeg({
			ffmpegPath: options.ffmpegPath,
			args: ["-af", `aresample=${VAD_SAMPLE_RATE}`],
			outputSampleRate: VAD_SAMPLE_RATE,
		}),
		options.streamContext,
	);

	resample._setup({ ...options.setupContext });

	return resample._pipe(monoStream);
}

export async function* readAnalysisStream(stream: ReadableStream<Block>): AsyncGenerator<Block> {
	const reader = stream.getReader();

	try {
		for (;;) {
			const result = await reader.read();

			if (result.done) return;

			yield result.value;
		}
	} finally {
		await reader.cancel();
	}
}

async function* downmixBlocks(blocks: AsyncIterable<Block>): AsyncGenerator<Block> {
	for await (const block of blocks) {
		yield {
			samples: [downmixToMono(block.samples)],
			offset: block.offset,
			sampleRate: block.sampleRate,
			bitDepth: block.bitDepth,
		};
	}
}
