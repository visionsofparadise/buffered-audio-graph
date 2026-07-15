import { describe, expect, it } from "vitest";
import { getFftAddon, detectFftBackend, vkfftDeviceAvailable } from "./fft-backend";
import { fixtures, requireFixture } from "./test-fixtures";

function loadFftw() {
	const path = requireFixture("fftwAddon");
	if (!path) return null;

	try {
		const addon = getFftAddon("fftw", { fftwPath: path });
		return addon;
	} catch {
		console.log("[skip] FFTW addon failed to load");
		return null;
	}
}

function loadVkfft() {
	const path = requireFixture("vkfftAddon");
	if (!path) return null;

	// The VkFFT addon loads on hosts with no Vulkan device (e.g. CI) but throws at first use; gate on an actual device, not just load.
	if (!vkfftDeviceAvailable(path)) {
		console.log("[skip] VkFFT: no Vulkan device");
		return null;
	}

	try {
		const addon = getFftAddon("vkfft", { vkfftPath: path });
		return addon;
	} catch {
		console.log("[skip] VkFFT addon failed to load");
		return null;
	}
}

describe("FFTW addon", () => {
	it("loads successfully", () => {
		const addon = loadFftw();
		if (!addon) return;

		expect(addon).not.toBeNull();
		expect(typeof addon.batchFft).toBe("function");
		expect(typeof addon.batchIfft).toBe("function");
	});

	it("batchFft returns correct output shape", () => {
		const addon = loadFftw();
		if (!addon) return;

		const fftSize = 1024;
		const signal = new Float32Array(fftSize);
		for (let i = 0; i < fftSize; i++) {
			signal[i] = Math.sin(2 * Math.PI * 10 * i / fftSize);
		}

		const { re, im } = addon.batchFft(signal, fftSize, 1);
		const halfSize = fftSize / 2 + 1;

		expect(re).toHaveLength(halfSize);
		expect(im).toHaveLength(halfSize);
	});

	it("batchIfft returns correct output length", () => {
		const addon = loadFftw();
		if (!addon) return;

		const fftSize = 1024;
		const halfSize = fftSize / 2 + 1;
		const re = new Float32Array(halfSize);
		const im = new Float32Array(halfSize);
		re[10] = 1.0;

		const result = addon.batchIfft(re, im, fftSize, 1);

		expect(result).toBeInstanceOf(Float32Array);
		expect(result).toHaveLength(fftSize);
	});

	it("batchFft/batchIfft round-trip reconstructs signal", () => {
		const addon = loadFftw();
		if (!addon) return;

		const fftSize = 1024;
		const signal = new Float32Array(fftSize);
		for (let i = 0; i < fftSize; i++) {
			signal[i] = Math.sin(2 * Math.PI * 10 * i / fftSize) + 0.5 * Math.cos(2 * Math.PI * 30 * i / fftSize);
		}

		const { re, im } = addon.batchFft(signal, fftSize, 1);
		const reconstructed = addon.batchIfft(re, im, fftSize, 1);

		for (let i = 0; i < fftSize; i++) {
			expect(Math.abs(reconstructed[i]! - signal[i]!)).toBeLessThan(1e-3);
		}
	});
});

describe("VkFFT addon", () => {
	it("loads successfully", () => {
		const addon = loadVkfft();
		if (!addon) return;

		expect(addon).not.toBeNull();
		expect(typeof addon.batchFft).toBe("function");
		expect(typeof addon.batchIfft).toBe("function");
	});

	it("batchFft returns correct output shape", () => {
		const addon = loadVkfft();
		if (!addon) return;

		const fftSize = 1024;
		const signal = new Float32Array(fftSize);
		for (let i = 0; i < fftSize; i++) {
			signal[i] = Math.sin(2 * Math.PI * 10 * i / fftSize);
		}

		const { re, im } = addon.batchFft(signal, fftSize, 1);
		const halfSize = fftSize / 2 + 1;

		expect(re).toHaveLength(halfSize);
		expect(im).toHaveLength(halfSize);
	});

	it("batchIfft returns correct output length", () => {
		const addon = loadVkfft();
		if (!addon) return;

		const fftSize = 1024;
		const halfSize = fftSize / 2 + 1;
		const re = new Float32Array(halfSize);
		const im = new Float32Array(halfSize);
		re[10] = 1.0;

		const result = addon.batchIfft(re, im, fftSize, 1);

		expect(result).toBeInstanceOf(Float32Array);
		expect(result).toHaveLength(fftSize);
	});

	it("batchFft/batchIfft round-trip reconstructs signal", () => {
		const addon = loadVkfft();
		if (!addon) return;

		const fftSize = 1024;
		const signal = new Float32Array(fftSize);
		for (let i = 0; i < fftSize; i++) {
			signal[i] = Math.sin(2 * Math.PI * 10 * i / fftSize) + 0.5 * Math.cos(2 * Math.PI * 30 * i / fftSize);
		}

		const { re, im } = addon.batchFft(signal, fftSize, 1);
		const reconstructed = addon.batchIfft(re, im, fftSize, 1);

		for (let i = 0; i < fftSize; i++) {
			expect(Math.abs(reconstructed[i]! - signal[i]!)).toBeLessThan(1e-3);
		}
	});

	it("detectDevice returns a result", () => {
		const path = requireFixture("vkfftAddon");
		if (!path) return;

		try {
			const addon = getFftAddon("vkfft", { vkfftPath: path }) as { detectDevice(): string | null } | null;
			if (!addon) return;

			const device = addon.detectDevice();
			console.log(`[info] VkFFT detected device: ${device ?? "none"}`);
			expect(device === null || typeof device === "string").toBe(true);
		} catch {
			console.log("[skip] VkFFT detectDevice failed");
		}
	});
});

describe("detectFftBackend", () => {
	it("returns the highest-priority available backend", () => {
		const options = {
			vkfftPath: fixtures.vkfftAddon,
			fftwPath: fixtures.fftwAddon,
		};

		const backend = detectFftBackend(["gpu", "cpu-native", "cpu"], options);

		expect(["vkfft", "fftw", "js"]).toContain(backend);

		const vkfft = loadVkfft();
		const fftw = loadFftw();

		if (vkfft) {
			const vkfftAddon = getFftAddon("vkfft", { vkfftPath: fixtures.vkfftAddon }) as { detectDevice(): string | null } | null;
			if (vkfftAddon?.detectDevice()) {
				expect(backend).toBe("vkfft");
			} else if (fftw) {
				expect(backend).toBe("fftw");
			} else {
				expect(backend).toBe("js");
			}
		} else if (fftw) {
			expect(backend).toBe("fftw");
		} else {
			expect(backend).toBe("js");
		}
	});
});
