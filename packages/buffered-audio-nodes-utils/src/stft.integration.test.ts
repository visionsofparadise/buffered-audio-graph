import { stft, istft } from "./stft";
import type { FftBackend } from "./fft-backend";
import { getFftAddon, vkfftDeviceAvailable } from "./fft-backend";
import { fixtures, requireFixture } from "./test-fixtures";

const sampleRate = 48000;
const duration = 1;
const length = sampleRate * duration;
const fftSize = 2048;
const hopSize = 512;

function generateSignal(): Float32Array {
	const signal = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		const t = i / sampleRate;
		signal[i] = Math.sin(2 * Math.PI * 440 * t)
			+ 0.7 * Math.sin(2 * Math.PI * 1000 * t)
			+ 0.5 * Math.sin(2 * Math.PI * 2500 * t);
	}

	return signal;
}

function tryLoadBackend(backend: FftBackend, fixtureName: "fftwAddon" | "vkfftAddon"): boolean {
	const path = requireFixture(fixtureName);
	if (!path) return false;

	// VkFFT loads without a Vulkan device (e.g. CI) but throws at first use; require an actual device.
	if (backend === "vkfft" && !vkfftDeviceAvailable(path)) {
		console.log("[skip] vkfft: no Vulkan device");
		return false;
	}

	try {
		const addon = getFftAddon(backend, {
			vkfftPath: backend === "vkfft" ? path : undefined,
			fftwPath: backend === "fftw" ? path : undefined,
		});
		return addon !== null;
	} catch {
		console.log(`[skip] ${backend} addon failed to load`);
		return false;
	}
}

function getAddonOptions(backend: FftBackend): { vkfftPath?: string; fftwPath?: string } {
	if (backend === "vkfft") return { vkfftPath: fixtures.vkfftAddon };
	if (backend === "fftw") return { fftwPath: fixtures.fftwAddon };
	return {};
}

function maxFrameError(jsResult: { real: Array<Float32Array>; imag: Array<Float32Array>; frames: number }, nativeResult: { real: Array<Float32Array>; imag: Array<Float32Array>; frames: number }): number {
	let maxError = 0;
	const frames = Math.min(jsResult.frames, nativeResult.frames);

	for (let f = 0; f < frames; f++) {
		const jsRe = jsResult.real[f]!;
		const jsIm = jsResult.imag[f]!;
		const natRe = nativeResult.real[f]!;
		const natIm = nativeResult.imag[f]!;
		const len = Math.min(jsRe.length, natRe.length);

		for (let i = 0; i < len; i++) {
			const reErr = Math.abs(jsRe[i]! - natRe[i]!);
			const imErr = Math.abs(jsIm[i]! - natIm[i]!);
			if (reErr > maxError) maxError = reErr;
			if (imErr > maxError) maxError = imErr;
		}
	}

	return maxError;
}

const backends: Array<{ name: FftBackend; fixture: "fftwAddon" | "vkfftAddon" }> = [
	{ name: "fftw", fixture: "fftwAddon" },
	{ name: "vkfft", fixture: "vkfftAddon" },
];

for (const { name, fixture } of backends) {
	describe(`STFT with ${name}`, () => {
		it("matches JS STFT output within 1e-2", () => {
			if (!tryLoadBackend(name, fixture)) return;

			const signal = generateSignal();
			const jsResult = stft(signal, fftSize, hopSize);
			const nativeResult = stft(signal, fftSize, hopSize, undefined, name, getAddonOptions(name));

			expect(nativeResult.frames).toBe(jsResult.frames);

			const error = maxFrameError(jsResult, nativeResult);
			expect(error).toBeLessThan(1e-2);
		});

		it("ISTFT round-trip reconstructs signal within 1e-3", () => {
			if (!tryLoadBackend(name, fixture)) return;

			const signal = generateSignal();
			const options = getAddonOptions(name);
			const result = stft(signal, fftSize, hopSize, undefined, name, options);
			const reconstructed = istft(result, hopSize, length, name, options);

			const trimStart = fftSize;
			const trimEnd = length - fftSize;
			let maxError = 0;

			for (let i = trimStart; i < trimEnd; i++) {
				const error = Math.abs(reconstructed[i]! - signal[i]!);
				if (error > maxError) maxError = error;
			}

			expect(maxError).toBeLessThan(1e-3);
		});
	});
}

describe("cross-backend STFT consistency", () => {
	it("FFTW and VkFFT produce matching STFT output within 1e-2", () => {
		const fftwAvailable = tryLoadBackend("fftw", "fftwAddon");
		const vkfftAvailable = tryLoadBackend("vkfft", "vkfftAddon");

		if (!fftwAvailable || !vkfftAvailable) {
			console.log("[skip] cross-backend comparison requires both FFTW and VkFFT");
			return;
		}

		const signal = generateSignal();
		const fftwResult = stft(signal, fftSize, hopSize, undefined, "fftw", getAddonOptions("fftw"));
		const vkfftResult = stft(signal, fftSize, hopSize, undefined, "vkfft", getAddonOptions("vkfft"));

		expect(fftwResult.frames).toBe(vkfftResult.frames);

		const error = maxFrameError(fftwResult, vkfftResult);
		expect(error).toBeLessThan(1e-2);
	});
});
