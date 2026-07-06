import { extname } from "node:path";
import { z } from "zod";
import { SourceNode, type SourceNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { ReadFfmpegStream } from "./ffmpeg";
import { ReadWavStream } from "./wav";

export const schema = z.object({
	path: z.string().default("").meta({ input: "file", mode: "open" }),
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
	ffprobePath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "ffprobe", download: "https://ffmpeg.org/download.html" })
		.describe("FFprobe — media file analyzer (included with FFmpeg)"),
});

export interface ReadProperties extends z.infer<typeof schema>, SourceNodeProperties {
	readonly channels?: ReadonlyArray<number>;
}

export class ReadNode extends SourceNode<ReadProperties> {
	static override readonly nodeName = "Read";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription = "Read audio from a file";
	static override readonly schema = schema;
	override readonly type = ["buffered-audio-node", "source", "read"] as const;

	protected override createStream(): ReadWavStream<ReadProperties> | ReadFfmpegStream<ReadProperties> {
		const ext = extname(this.properties.path).toLowerCase();

		if (ext === ".wav") {
			return new ReadWavStream(this.properties);
		}

		if (!this.properties.ffmpegPath || !this.properties.ffprobePath) {
			throw new Error(`Non-WAV file requires ffmpegPath and ffprobePath: "${this.properties.path}"`);
		}

		return new ReadFfmpegStream(this.properties);
	}

	clone(overrides?: Partial<ReadProperties>): ReadNode {
		return new ReadNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function read(path: string, options?: { channels?: ReadonlyArray<number>; ffmpegPath?: string; ffprobePath?: string }): ReadNode {
	return new ReadNode({ path, channels: options?.channels, ffmpegPath: options?.ffmpegPath ?? "", ffprobePath: options?.ffprobePath ?? "" });
}
