import { z } from "zod";

export function createFfmpegPathField(description = "FFmpeg — audio/video processing tool") {
	return z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" })
		.describe(description);
}

export function createLoudnessToolPathField() {
	return z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			binary: "loudness-tool",
			download: "https://github.com/visionsofparadise/loudness-tool/releases/latest",
		})
		.describe("loudness-tool — loudness measurement and processing CLI");
}

export function createOnnxAddonPathField() {
	return z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			binary: "onnx-addon",
			download: "https://github.com/visionsofparadise/onnx-runtime-addon",
		})
		.describe("ONNX Runtime native addon");
}

export function createVkfftAddonPathField() {
	return z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			binary: "vkfft-addon",
			download: "https://github.com/visionsofparadise/vkfft-addon",
		})
		.describe("VkFFT native addon — GPU FFT acceleration");
}

export function createFftwAddonPathField() {
	return z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			binary: "fftw-addon",
			download: "https://github.com/visionsofparadise/fftw-addon",
		})
		.describe("FFTW native addon — CPU FFT acceleration");
}

export function createFaustAddonPathField() {
	return z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			binary: "faust-addon",
			download: "https://github.com/visionsofparadise/faust-addon",
		})
		.describe("Faust native addon — libfaust + LLVM JIT");
}
