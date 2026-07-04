import { describe, it } from "vitest";
import { runBenchmark, type BenchmarkResult } from "./test-benchmark";
import { audio, binaries } from "./test-binaries";
import { dtln } from "../transforms/dtln";
import { kimVocal2 } from "../transforms/kim-vocal-2";
import { htdemucs } from "../transforms/htdemucs";
import { ExecutionProvider } from "@buffered-audio/core";

const testVoice = audio.testVoice;

const fftConfigs: Array<{ label: string; providers: ReadonlyArray<ExecutionProvider> }> = [
	{ label: "js", providers: ["cpu"] },
	{ label: "fftw", providers: ["cpu-native", "cpu"] },
	{ label: "vkfft", providers: ["gpu", "cpu"] },
];

const onnxConfigs: Array<{ label: string; providers: ReadonlyArray<ExecutionProvider> }> = [
	{ label: "cpu", providers: ["cpu"] },
	{ label: "gpu+cpu", providers: ["gpu", "cpu-native", "cpu"] },
];

const allResults: Array<{
	group: string;
	transform: string;
	backend: string;
	totalMs: number;
	rtx: number;
	samplesPerSec: number;
}> = [];

function record(group: string, transform: string, backend: string, r: BenchmarkResult) {
	allResults.push({
		group,
		transform,
		backend,
		totalMs: r.totalMs,
		rtx: r.realTimeMultiplier,
		samplesPerSec: r.samplesPerSecond,
	});
}

describe("FFT backends", () => {
	for (const { label, providers } of fftConfigs) {
		it(`dtln [${label}]`, async () => {
			const t = dtln({ modelPath1: binaries.model1, modelPath2: binaries.model2, ffmpegPath: binaries.ffmpeg, onnxAddonPath: binaries.onnxAddon, vkfftAddonPath: binaries.vkfftAddon, fftwAddonPath: binaries.fftwAddon });
			const r = await runBenchmark(`dtln`, t, testVoice, { executionProviders: providers });
			record("fft", "dtln", label, r);
		}, 240_000);
	}
});

describe("ONNX models", () => {
	for (const { label, providers } of onnxConfigs) {
		it(`dtln [${label}]`, async () => {
			const t = dtln({ modelPath1: binaries.model1, modelPath2: binaries.model2, ffmpegPath: binaries.ffmpeg, onnxAddonPath: binaries.onnxAddon, vkfftAddonPath: binaries.vkfftAddon, fftwAddonPath: binaries.fftwAddon });
			const r = await runBenchmark(`dtln`, t, testVoice, { executionProviders: providers });
			record("onnx", "dtln", label, r);
		}, 240_000);
	}

	for (const { label, providers } of onnxConfigs) {
		it(`kim-vocal-2 [${label}]`, async () => {
			const t = kimVocal2({ modelPath: binaries.kimVocal2, ffmpegPath: binaries.ffmpeg, onnxAddonPath: binaries.onnxAddon });
			const r = await runBenchmark(`kim-vocal-2`, t, testVoice, { executionProviders: providers });
			record("onnx", "kim-vocal-2", label, r);
		}, 240_000);
	}

	for (const { label, providers } of onnxConfigs) {
		it(`htdemucs [${label}]`, async () => {
			const t = htdemucs(binaries.htdemucs, { vocals: 1, drums: 0, bass: 0, other: 0 }, { onnxAddonPath: binaries.onnxAddon });
			const r = await runBenchmark(`htdemucs`, t, testVoice, { executionProviders: providers });
			record("onnx", "htdemucs", label, r);
		}, 240_000);
	}
});

describe("summary", () => {
	it("print results", () => {
		const pad = (s: string, n: number) => s.padStart(n);
		const rpad = (s: string, n: number) => s.padEnd(n);

		console.log("\n");
		console.log("=".repeat(90));
		console.log("  FULL BENCHMARK — test-voice.wav");
		console.log("=".repeat(90));

		console.log("\n  FFT BACKENDS");
		console.log("  " + "-".repeat(86));
		console.log(
			"  " +
				rpad("Transform", 22) +
				pad("js", 12) +
				pad("fftw", 12) +
				pad("vkfft", 12) +
				pad("fftw/js", 10) +
				pad("vkfft/js", 10) +
				pad("best", 10),
		);
		console.log("  " + "-".repeat(86));

		const fftTransforms = [...new Set(allResults.filter((r) => r.group === "fft").map((r) => r.transform))];
		for (const transform of fftTransforms) {
			const js = allResults.find((r) => r.group === "fft" && r.transform === transform && r.backend === "js");
			const fftw = allResults.find((r) => r.group === "fft" && r.transform === transform && r.backend === "fftw");
			const vkfft = allResults.find((r) => r.group === "fft" && r.transform === transform && r.backend === "vkfft");

			const fmt = (r?: (typeof allResults)[0]) => (r ? `${r.totalMs.toFixed(0)}ms` : "—");
			const ratio = (a?: (typeof allResults)[0], b?: (typeof allResults)[0]) =>
				a && b ? `${(b.totalMs / a.totalMs).toFixed(2)}x` : "—";
			const best = [
				{ l: "js", ms: js?.totalMs ?? Infinity },
				{ l: "fftw", ms: fftw?.totalMs ?? Infinity },
				{ l: "vkfft", ms: vkfft?.totalMs ?? Infinity },
			].sort((a, b) => a.ms - b.ms)[0]!.l;

			console.log(
				"  " +
					rpad(transform, 22) +
					pad(fmt(js), 12) +
					pad(fmt(fftw), 12) +
					pad(fmt(vkfft), 12) +
					pad(ratio(fftw, js), 10) +
					pad(ratio(vkfft, js), 10) +
					pad(best, 10),
			);
		}

		console.log("\n  " + rpad("(real-time)", 22));
		for (const transform of fftTransforms) {
			const js = allResults.find((r) => r.group === "fft" && r.transform === transform && r.backend === "js");
			const fftw = allResults.find((r) => r.group === "fft" && r.transform === transform && r.backend === "fftw");
			const vkfft = allResults.find((r) => r.group === "fft" && r.transform === transform && r.backend === "vkfft");

			const fmt = (r?: (typeof allResults)[0]) => (r ? `${r.rtx.toFixed(1)}x RT` : "—");
			console.log("  " + rpad(transform, 22) + pad(fmt(js), 12) + pad(fmt(fftw), 12) + pad(fmt(vkfft), 12));
		}

		console.log("\n  ONNX MODELS");
		console.log("  " + "-".repeat(60));
		console.log("  " + rpad("Transform", 22) + pad("cpu", 14) + pad("gpu+cpu", 14) + pad("speedup", 12));
		console.log("  " + "-".repeat(60));

		const onnxTransforms = [...new Set(allResults.filter((r) => r.group === "onnx").map((r) => r.transform))];
		for (const transform of onnxTransforms) {
			const cpu = allResults.find((r) => r.group === "onnx" && r.transform === transform && r.backend === "cpu");
			const gpu = allResults.find((r) => r.group === "onnx" && r.transform === transform && r.backend === "gpu+cpu");

			const fmt = (r?: (typeof allResults)[0]) => (r ? `${r.totalMs.toFixed(0)}ms` : "—");
			const ratio = cpu && gpu ? `${(cpu.totalMs / gpu.totalMs).toFixed(2)}x` : "—";
			console.log("  " + rpad(transform, 22) + pad(fmt(cpu), 14) + pad(fmt(gpu), 14) + pad(ratio, 12));
		}

		console.log("\n  " + rpad("(real-time)", 22));
		for (const transform of onnxTransforms) {
			const cpu = allResults.find((r) => r.group === "onnx" && r.transform === transform && r.backend === "cpu");
			const gpu = allResults.find((r) => r.group === "onnx" && r.transform === transform && r.backend === "gpu+cpu");

			const fmt = (r?: (typeof allResults)[0]) => (r ? `${r.rtx.toFixed(2)}x RT` : "—");
			console.log("  " + rpad(transform, 22) + pad(fmt(cpu), 14) + pad(fmt(gpu), 14));
		}

		console.log("\n" + "=".repeat(90));
		console.log(`  Node ${process.version} | ${process.platform}-${process.arch}`);
		console.log("=".repeat(90));
	});
});
