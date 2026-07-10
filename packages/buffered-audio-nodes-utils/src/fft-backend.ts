import { createRequire } from "node:module";
import type { ExecutionProvider } from "@buffered-audio/core";

export type FftBackend = "vkfft" | "fftw" | "js";

interface FftAddon {
	batchFft(input: Float32Array, fftSize: number, batchCount: number): { re: Float32Array; im: Float32Array };
	batchIfft(re: Float32Array, im: Float32Array, fftSize: number, batchCount: number): Float32Array;
	batchFft2D(input: Float32Array, rows: number, cols: number, batchCount: number): { re: Float32Array; im: Float32Array };
	batchIfft2D(re: Float32Array, im: Float32Array, rows: number, cols: number, batchCount: number): Float32Array;
	batchFftInto?(input: Float32Array, outRe: Float32Array, outIm: Float32Array, fftSize: number, batchCount: number): void;
	batchIfftInto?(re: Float32Array, im: Float32Array, outTime: Float32Array, fftSize: number, batchCount: number): void;
}

interface VkFftAddon extends FftAddon {
	detectDevice(): string | null;
}

const require = createRequire(import.meta.url);

function tryLoadVkfft(vkfftPath?: string): VkFftAddon | null {
	if (!vkfftPath) return null;

	try {
		return require(vkfftPath) as VkFftAddon;
	} catch {
		return null;
	}
}

function tryLoadFftw(fftwPath?: string): FftAddon | null {
	if (!fftwPath) return null;

	try {
		return require(fftwPath) as FftAddon;
	} catch {
		return null;
	}
}

export function detectFftBackend(executionProviders: ReadonlyArray<ExecutionProvider>, options?: { vkfftPath?: string; fftwPath?: string }): FftBackend {
	for (const provider of executionProviders) {
		if (provider === "gpu") {
			const vkfft = tryLoadVkfft(options?.vkfftPath);

			if (vkfft) {
				const device = vkfft.detectDevice();

				if (device) {
					return "vkfft";
				}
			}
		}

		if (provider === "cpu-native") {
			const fftw = tryLoadFftw(options?.fftwPath);

			if (fftw) {
				return "fftw";
			}
		}

		if (provider === "cpu") {
			return "js";
		}
	}

	return "js";
}

export interface FftBackendConfig {
	readonly backend: FftBackend;
	readonly addonOptions: { vkfftPath?: string; fftwPath?: string };
}

export function initFftBackend(executionProviders: ReadonlyArray<ExecutionProvider>, properties: { vkfftAddonPath?: string; fftwAddonPath?: string }): FftBackendConfig {
	const addonOptions = { vkfftPath: properties.vkfftAddonPath, fftwPath: properties.fftwAddonPath };
	const backend = detectFftBackend(executionProviders, addonOptions);

	return { backend, addonOptions };
}

export function getFftAddon(backend: FftBackend, options?: { vkfftPath?: string; fftwPath?: string }): FftAddon | null {
	if (backend === "vkfft") return tryLoadVkfft(options?.vkfftPath);
	if (backend === "fftw") return tryLoadFftw(options?.fftwPath);

	return null;
}

export function vkfftDeviceAvailable(vkfftPath?: string): boolean {
	return Boolean(tryLoadVkfft(vkfftPath)?.detectDevice());
}
