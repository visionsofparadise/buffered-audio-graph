import { describe, expect, it } from "vitest";
import { ReadFfmpegNode, readFfmpeg } from ".";

describe("ReadFfmpegNode", () => {
	it("creates a ReadFfmpegNode via readFfmpeg convenience function", () => {
		const node = readFfmpeg("test.mp3", { ffmpegPath: "/usr/bin/ffmpeg", ffprobePath: "/usr/bin/ffprobe" });

		expect(node).toBeInstanceOf(ReadFfmpegNode);
	});

	it("creates a ReadFfmpegNode with channel selection", () => {
		const node = readFfmpeg("test.mp3", { channels: [0], ffmpegPath: "/usr/bin/ffmpeg", ffprobePath: "/usr/bin/ffprobe" });

		expect(node).toBeInstanceOf(ReadFfmpegNode);
	});
});
