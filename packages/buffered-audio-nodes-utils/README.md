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
| `stft(signal, fftSize, hopSize, window?)` | Short-Time Fourier Transform with tiered backend dispatch |
| `istft(frames, fftSize, hopSize, window?)` | Inverse STFT (overlap-add reconstruction) |
| `fft(real, imag)` | Forward FFT (Cooley-Tukey radix-2, in-place) |
| `ifft(real, imag)` | Inverse FFT (in-place) |
| `hanningWindow(size)` | Generate a Hann window of the given size |
| `MixedRadixFft` | FFT class for non-power-of-2 sizes |
| `createFftWorkspace(size)` | Allocate reusable FFT scratch buffers |
| `bitReverse(...)` | Bit-reversal permutation |
| `butterflyStages(...)` | Radix-2 butterfly computation |

```ts
const window = hanningWindow(2048);
const frames = stft(signal, 2048, 512, window);

// ... process frames ...

const reconstructed = istft(frames, 2048, 512, window);
```

### FFT Backend

```ts
import { initFftBackend, detectFftBackend, getFftAddon } from "@buffered-audio/utils";
import type { FftBackend, FftBackendConfig } from "@buffered-audio/utils";
```

| Function | Description |
| --- | --- |
| `initFftBackend(config)` | Initialize the native FFT backend |
| `detectFftBackend(config)` | Auto-detect the best available backend |
| `getFftAddon(config)` | Get the loaded native addon |

The FFT backend uses tiered dispatch to select the fastest available implementation:

1. **VkFFT** (GPU via Vulkan) -- highest throughput for large transforms
2. **FFTW** (native CPU) -- optimized native fallback
3. **JavaScript** -- pure JS fallback, always available

`stft` and `istft` automatically use the best initialized backend.

```ts
await initFftBackend({ backend: "vkfft" });
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
| `biquadFilter(samples, coefficients, state)` | Apply a biquad IIR filter |
| `zeroPhaseBiquadFilter(samples, coefficients)` | Zero-phase (forward-backward) biquad filter |
| `highPassCoefficients(frequency, sampleRate, Q?)` | Design a high-pass biquad filter |
| `lowPassCoefficients(frequency, sampleRate, Q?)` | Design a low-pass biquad filter |
| `preFilterCoefficients(sampleRate)` | BS.1770-4 pre-filter (high shelf at ~1500 Hz) |
| `rlbFilterCoefficients(sampleRate)` | BS.1770-4 RLB weighting filter |
| `bandpass(signal, low, high, sampleRate)` | Convenience bandpass using cascaded biquads |

```ts
const coeffs = lowPassCoefficients(1000, 48000);
const state = { x1: 0, x2: 0, y1: 0, y2: 0 };
const filtered = biquadFilter(samples, coeffs, state);
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

### Resampling

```ts
import { resampleDirect } from "@buffered-audio/utils";
```

| Function | Description |
| --- | --- |
| `resampleDirect(signal, fromRate, toRate)` | Sample rate conversion via direct resampling |

## License

ISC
