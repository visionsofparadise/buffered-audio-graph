# @buffered-audio/utils

Shared DSP utilities for the buffered-audio-nodes ecosystem.

## Install

```bash
npm install @buffered-audio/utils
```

Peer dependency: `@buffered-audio/core`

## API

### STFT / FFT

```ts
import { stft, istft, fft, ifft, hanningWindow, MixedRadixFft } from "@buffered-audio/utils";
```

| Function | Description |
| --- | --- |
| `stft(signal, fftSize, hopSize, output?, backend?, fftAddonOptions?)` | Short-time Fourier transform, optionally into caller-owned output with a selected backend |
| `istft(result, hopSize, outputLength, backend?, fftAddonOptions?)` | Inverse STFT with overlap-add reconstruction |
| `fft(input, workspace?)` | Radix-2 forward FFT returning real and imaginary arrays |
| `ifft(re, im, workspace?)` | Radix-2 inverse FFT returning the real time-domain array |
| `hanningWindow(size, periodic?)` | Return a periodic or symmetric Hann window |
| `new MixedRadixFft(size)` | Create an FFT for sizes factored only by 2, 3, and 5 |
| `createFftWorkspace(size)` | Allocate reusable FFT scratch buffers |

```ts
const frames = stft(signal, 2048, 512);

// ... process frames ...

const reconstructed = istft(frames, 512, signal.length);
```

### FFT Backend

```ts
import { initFftBackend, detectFftBackend, getFftAddon } from "@buffered-audio/utils";
import type { FftBackend, FftBackendConfig } from "@buffered-audio/utils";
```

| Function | Description |
| --- | --- |
| `initFftBackend(executionProviders, properties)` | Select a backend and translate addon paths into STFT options |
| `detectFftBackend(executionProviders, options?)` | Select the first available requested backend |
| `getFftAddon(backend, options?)` | Load the selected native addon, or return `null` for JavaScript |

The FFT backend uses tiered dispatch to select the fastest available implementation:

1. **VkFFT** (GPU via Vulkan) -- highest throughput for large transforms
2. **FFTW** (native CPU) -- optimized native fallback
3. **JavaScript** -- pure JS fallback, always available

Pass the returned backend and addon options to `stft` or `istft`; omitting them uses JavaScript.

```ts
const fftConfig = initFftBackend(["gpu", "cpu-native", "cpu"], {
	vkfftAddonPath,
	fftwAddonPath,
});

const frames = stft(signal, 2048, 512, undefined, fftConfig.backend, fftConfig.addonOptions);
```

Native addon repositories:
- VkFFT: [visionsofparadise/vkfft-addon](https://github.com/visionsofparadise/vkfft-addon)
- FFTW: [visionsofparadise/fftw-addon](https://github.com/visionsofparadise/fftw-addon)

### Biquad Filters

```ts
import {
	biquadFilter,
	zeroPhaseBiquadFilter,
	highPassCoefficients,
	lowPassCoefficients,
	preFilterCoefficients,
	rlbFilterCoefficients,
	bandpass,
} from "@buffered-audio/utils";
```

| Function | Description |
| --- | --- |
| `biquadFilter(samples, fb, fa)` | Apply a zero-state biquad and return a new array |
| `zeroPhaseBiquadFilter(signal, coefficients)` | Apply zero-state forward/backward magnitude-squared filtering in place |
| `highPassCoefficients(sampleRate, frequency, quality?)` | Design a high-pass biquad filter |
| `lowPassCoefficients(sampleRate, frequency, quality?)` | Design a low-pass biquad filter |
| `preFilterCoefficients(sampleRate)` | Return the ITU-R BS.1770-5 K-weighting pre-filter |
| `rlbFilterCoefficients(sampleRate)` | Return the ITU-R BS.1770-5 RLB weighting filter |
| `bandpass(channels, sampleRate, highPass?, lowPass?)` | Apply optional high- and low-pass stages to planar channels in place |

```ts
const { fb, fa } = lowPassCoefficients(48000, 1000);
const filtered = biquadFilter(samples, fb, fa);
```

### Channel Operations

```ts
import { interleave, deinterleaveBuffer, replaceChannel } from "@buffered-audio/utils";
```

| Function | Description |
| --- | --- |
| `interleave(channels)` | Interleave per-channel arrays into a single buffer |
| `deinterleaveBuffer(buffer, channelCount)` | Deinterleave a buffer into per-channel arrays |
| `replaceChannel(samples, channelIndex, replacement)` | Replace a single channel in an interleaved buffer |

## License

ISC
