import { describe, expect, it } from "vitest";
import { applyDfttSmoothing, type DfttParams } from "./dftt-smoothing";
import { getFftAddon, vkfftDeviceAvailable, type FftBackend } from "./fft-backend";
import { requireFixture } from "./test-fixtures";

const params: DfttParams = {
	blockFreq: 4,
	blockTime: 4,
	hopFreq: 2,
	hopTime: 2,
	threshold: 0.35,
};

function getAvailableBackend(backend: FftBackend, fixture: "fftwAddon" | "vkfftAddon"): { readonly path: string; readonly options: { vkfftPath?: string; fftwPath?: string } } | null {
	const path = requireFixture(fixture);

	if (!path || backend === "vkfft" && !vkfftDeviceAvailable(path)) return null;

	const options = backend === "vkfft" ? { vkfftPath: path } : { fftwPath: path };

	try {
		const addon = getFftAddon(backend, options);

		if (!addon || typeof addon.batchFft2D !== "function" || typeof addon.batchIfft2D !== "function") return null;
	} catch {
		return null;
	}

	return { path, options };
}

function maximumError(actual: Float32Array, expected: Float32Array): number {
	let maximum = 0;

	for (let index = 0; index < actual.length; index++) {
		maximum = Math.max(maximum, Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)));
	}

	return maximum;
}

for (const { backend, fixture } of [
	{ backend: "fftw" as const, fixture: "fftwAddon" as const },
	{ backend: "vkfft" as const, fixture: "vkfftAddon" as const },
]) {
	describe(`DFTT with ${backend}`, () => {
		it("matches the JavaScript backend within 1e-6", () => {
			const available = getAvailableBackend(backend, fixture);

			if (!available) return;

			const numFrames = 7;
			const numBins = 9;
			const raw = Float32Array.from({ length: numFrames * numBins }, (_, index) => ((index * 23 + index % 7 * 5) % 101) / 100);
			const nlm = Float32Array.from({ length: raw.length }, (_, index) => ((index * 17 + 3) % 79) / 78);
			const jsOutput = new Float32Array(raw.length);
			const addonOutput = new Float32Array(raw.length);

			applyDfttSmoothing(nlm, raw, numFrames, numBins, params, jsOutput, undefined, undefined);
			applyDfttSmoothing(nlm, raw, numFrames, numBins, params, addonOutput, backend, available.options);

			expect(maximumError(addonOutput, jsOutput)).toBeLessThan(1e-6);
		});
	});
}
