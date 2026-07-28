import { z } from "zod";

export function createFfmpegPathField(description = "FFmpeg — audio/video processing tool") {
	return z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" })
		.describe(description);
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
