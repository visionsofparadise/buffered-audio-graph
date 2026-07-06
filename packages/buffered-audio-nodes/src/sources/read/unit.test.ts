import { describe, expect, it } from "vitest";
import { ReadFfmpegNode } from "./ffmpeg";
import { ReadWavNode } from "./wav";
import { read } from ".";

describe("read", () => {
	it("returns a ReadWavNode for .wav files", () => {
		const node = read("file.wav");

		expect(node).toBeInstanceOf(ReadWavNode);
	});

	it("returns a ReadFfmpegNode for non-WAV files with ffmpeg paths", () => {
		const node = read("file.mp3", { ffmpegPath: "/usr/bin/ffmpeg", ffprobePath: "/usr/bin/ffprobe" });

		expect(node).toBeInstanceOf(ReadFfmpegNode);
	});

	it("throws for non-WAV files without ffmpeg paths", () => {
		expect(() => read("test.mp3")).toThrow("Non-WAV file requires ffmpegPath and ffprobePath");
	});

	it("throws for non-WAV files when only ffmpegPath is set", () => {
		expect(() => read("test.flac", { ffmpegPath: "/usr/bin/ffmpeg" })).toThrow("Non-WAV file requires ffmpegPath and ffprobePath");
	});

	it("throws for non-WAV files when only ffprobePath is set", () => {
		expect(() => read("test.ogg", { ffprobePath: "/usr/bin/ffprobe" })).toThrow("Non-WAV file requires ffmpegPath and ffprobePath");
	});
});
