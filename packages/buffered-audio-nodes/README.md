# buffered-audio-nodes

A streaming audio processing framework. Chainable nodes that read, transform, and write audio — an open, scriptable, extensible alternative to GUI-bound audio engineering tools.

## Install

```bash
npm install @buffered-audio/nodes
```

## Usage

Three node types — sources produce audio, transforms process it, targets consume it. The `chain()` function wires them into a pipeline.

```ts
import { chain, read, normalize, write } from "@buffered-audio/nodes";

const pipeline = chain(read("input.wav"), normalize({ ceiling: 0.95 }), write("output.wav", { bitDepth: "24" }));

await pipeline.render();
```

`render()` streams audio through the chain. Backpressure, buffering, and lifecycle are handled by the framework.

### Fan-out

Split a stream into parallel branches by calling `.to()` multiple times from the same node:

```ts
import { chain, read, normalize, trim, write } from "@buffered-audio/nodes";

const source = read("input.wav");
const normalizeNode = normalize();
const trimNode = trim();

source.to(normalizeNode);
source.to(trimNode);
normalizeNode.to(write("normalized.wav"));
trimNode.to(write("trimmed.wav"));

await source.render();
```

## CLI

Render `.bag` files and run pipelines from the command line with [`@buffered-audio/cli`](https://www.npmjs.com/package/@buffered-audio/cli).

## Nodes

### Crest Reduce

Content-adaptive, magnitude-preserving, phase-only crest-factor reducer — a pre-limiter headroom stage that rearranges signal phase to flatten true-peak excursions without changing the magnitude spectrum, never increasing crest factor

[Source](./src/transforms/crest-reduce/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `smoothing` | number (min 0) | `100` | Bidirectional (zero-phase) smoothing time constant in ms applied to the per-frame decorrelation envelope before it drives the lattice (default 100 ms). The envelope is 0 in segments with no active-band peak and the per-binding-peak optimal value at active-band peaks; smoothing eases it toward 0 across gaps so the bidirectional pass is predictable. Applied to the CONTROL trajectory only — never the audio path |
| `frameSize` | number | `2048` | Analysis frame length in samples (default 2048 @ 48 kHz ≈ 43 ms; 75% overlap, Hann analysis window). Whole-file processing — output is produced after the full input is accumulated |
| `vkfftAddonPath` | string | `""` | VkFFT native addon — GPU FFT acceleration Download: [vkfft-addon](https://github.com/visionsofparadise/vkfft-addon) |
| `fftwAddonPath` | string | `""` | FFTW native addon — CPU FFT acceleration Download: [fftw-addon](https://github.com/visionsofparadise/fftw-addon) |

### Cut

Remove a region of audio

[Source](./src/transforms/cut/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `regions` | Object[] | `[]` | Regions |
| `regions[].start` | number (min 0) | — | Start (seconds) |
| `regions[].end` | number (min 0) | — | End (seconds) |

### De-Bleed Adaptive

Adaptive (MEF FDAF Kalman + MWF + MSAD) reference-based microphone bleed reduction. Stages 1+2 are MEF Meyer-Elshamy-Fingscheidt 2020; Stage 3 is Lukin-Todd 2D NLM+DFTT post-filter.

[Source](./src/transforms/de-bleed/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `references` | string[] | `[]` | References |
| `reductionStrength` | number (0 to 10, step 0.1) | `5` | Reduction Strength |
| `artifactSmoothing` | number (0 to 10, step 0.1) | `5` | Artifact Smoothing |
| `adaptationSpeed` | number (0 to 10, step 0.1) | `3` | Adaptation Speed |
| `fftSize` | number (512 to 16384, step 256) | `4096` | FFT Size |
| `hopSize` | number (128 to 4096, step 64) | `1024` | Hop Size |
| `vkfftAddonPath` | string | `""` | VkFFT native addon — GPU FFT acceleration Download: [vkfft-addon](https://github.com/visionsofparadise/vkfft-addon) |
| `fftwAddonPath` | string | `""` | FFTW native addon — CPU FFT acceleration Download: [fftw-addon](https://github.com/visionsofparadise/fftw-addon) |
| `dfttBackend` | "" \| "js" \| "fftw" \| "vkfft" | `""` | DFTT Backend Override |

### DeepFilterNet3 (Denoiser)

Remove background noise from speech using DeepFilterNet3 (48 kHz full-band CRN)

[Source](./src/transforms/deep-filter-net-3/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `modelPath` | string | `""` | DeepFilterNet3 48 kHz denoiser model (.onnx) Download: [dfn3](https://github.com/yuyun2000/SpeechDenoiser) |
| `ffmpegPath` | string | `""` | FFmpeg — only used when sampleRate ≠ 48000 to chain up/down resamplers around the inference stream; can be left blank when sampleRate === 48000. Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `onnxAddonPath` | string | `""` | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon) |
| `sampleRate` | number (min 0) | — | Source audio sample rate in Hz. Required. When ≠ 48000, ffmpeg resampling is chained around the inference stream via _setup composition. |
| `attenuation` | number (0 to 100) | `30` | Attenuation cap in dB. Maps to the ONNX `atten_lim_db` input; 0 = no cap |

### Dither

Add shaped noise to reduce quantization distortion

[Source](./src/transforms/dither/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `bitDepth` | 16 \| 24 | `16` | Bit Depth |
| `noiseShaping` | boolean | `false` | Noise Shaping |

### Downmix Mono

Mix all input channels to a single mono channel by averaging

[Source](./src/transforms/downmix-mono/index.ts)

### DTLN (Denoiser)

Remove background noise from speech using DTLN neural network

[Source](./src/transforms/dtln/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `modelPath1` | string | `""` | DTLN magnitude mask model (.onnx) Download: [dtln-model_1](https://github.com/breizhn/DTLN) |
| `modelPath2` | string | `""` | DTLN time-domain model (.onnx) Download: [dtln-model_2](https://github.com/breizhn/DTLN) |
| `ffmpegPath` | string | `""` | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `onnxAddonPath` | string | `""` | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon) |
| `vkfftAddonPath` | string | `""` | VkFFT native addon — GPU FFT acceleration Download: [vkfft-addon](https://github.com/visionsofparadise/vkfft-addon) |
| `fftwAddonPath` | string | `""` | FFTW native addon — CPU FFT acceleration Download: [fftw-addon](https://github.com/visionsofparadise/fftw-addon) |

### Duplicate Channels

Duplicate a mono signal into multiple identical output channels; requires exactly 1 input channel, throws otherwise

[Source](./src/transforms/duplicate-channels/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `channels` | number (2 to 8) | `2` | Output channel count |

### FFmpeg

Process audio through FFmpeg filters

[Source](./src/transforms/ffmpeg/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `ffmpegPath` | string | `""` | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `args` | string[] | `[]` |  |
| `outputSampleRate` | number (min 0), optional | — | Sample rate of emitted chunks. Required when args change the rate (e.g. -af aresample=24000). |

### Gain

Adjust signal level by a fixed amount in dB

[Source](./src/transforms/gain/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `gain` | number (-60 to 24, step 0.1) | `0` | Gain (dB) |

### HTDemucs (Stem Separator)

Rebalance stem volumes using HTDemucs source separation

[Source](./src/transforms/htdemucs/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `modelPath` | string | `""` | HTDemucs source separation model (.onnx) — requires .onnx.data file alongside Download: [htdemucs](https://github.com/facebookresearch/demucs) |
| `ffmpegPath` | string | `""` | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `onnxAddonPath` | string | `""` | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon) |
| `highPass` | number (0 to 500, step 10) | `0` | High Pass |
| `lowPass` | number (0 to 22050, step 100) | `0` | Low Pass |

### Kim Vocal 2 (Stem Separator)

Isolate dialogue from background using MDX-Net vocal separation

[Source](./src/transforms/kim-vocal-2/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `modelPath` | string | `""` | MDX-Net vocal isolation model (.onnx) Download: [Kim_Vocal_2](https://huggingface.co/seanghay/uvr_models) |
| `ffmpegPath` | string | `""` | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `onnxAddonPath` | string | `""` | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon) |
| `highPass` | number (20 to 500, step 10) | `80` | High Pass |
| `lowPass` | number (1000 to 22050, step 100) | `20000` | Low Pass |

### Loudness Normalize

Measure integrated loudness (BS.1770) and apply a single linear gain to hit a target LUFS — no limiting, no dynamics

[Source](./src/transforms/loudness-normalize/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `target` | number (-50 to 0, step 0.1) | `-16` | Target integrated loudness (LUFS) |

### Loudness Stats

Measure integrated loudness, true peak, and loudness range per EBU R128, plus an amplitude-distribution histogram

[Source](./src/targets/loudness-stats/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `bucketCount` | number (min 0) | `1024` | Amplitude histogram bucket count |
| `outputPath` | string | `""` | Output Path (JSON sidecar). Empty string disables file output. |

### Loudness Target

Peak-aware content-adaptive curve fitting (LUFS, true-peak, LRA) via a single combined gain envelope with a peak-respecting two-stage smoother. The upper-arm peak anchor jointly iterates with the body gain to land both LUFS and true-peak targets in one envelope.

[Source](./src/transforms/loudness-target/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `targetLufs` | number (-50 to 0, step 0.1) | `-16` | Target integrated loudness (LUFS) |
| `pivot` | number (max 0), optional | — | Body anchor (dB). Default: median(considered LRA blocks) from BS.1770 LRA gating in pass 1. |
| `floor` | number (max 0), optional | — | Silence threshold (dB). Default: min(considered LRA blocks); no floor when no blocks survive gating. |
| `limitPercentile` | number (0.5 to 1) | `0.995` | Top-1−p fraction of detection samples to brick-wall. Default 0.995 brick-walls the top 0.5%. |
| `limitDb` | number (max 0), optional | — | Limit-anchor override (dB). Default: auto-derived from quantile(detection histogram, limitPercentile). Set explicitly to fix the limit anchor. |
| `maxAttempts` | number (min 1) | `10` | Hard cap on iteration attempts. |
| `targetTp` | number (max 0), optional | — | True-peak target (dBTP). Default: source true peak (peaks unchanged). |
| `smoothing` | number (0.01 to 200) | `1` | Peak-respecting envelope time constant (ms). |
| `tolerance` | number (min 0) | `0.5` | Iteration exit threshold (LUFS dB). |
| `peakTolerance` | number (min 0) | `0.1` | One-sided iteration exit threshold for output true-peak overshoot (dBTP; ceiling — undershoot ignored). |

### Normalize

Adjust peak or loudness level to a target ceiling

[Source](./src/transforms/normalize/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `ceiling` | number (0 to 1, step 0.01) | `1` | Ceiling |

### Pad

Add silence to start or end of audio

[Source](./src/transforms/pad/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `before` | number (min 0, step 0.001) | `0` | Before |
| `after` | number (min 0, step 0.001) | `0` | After |

### Pan

Position mono signal in stereo field or adjust stereo balance; throws for inputs with more than 2 channels

[Source](./src/transforms/pan/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `pan` | number (-1 to 1, step 0.01) | `0` | Pan (-1 = full left, 0 = center, 1 = full right) |

### Phase

Invert or rotate signal phase

[Source](./src/transforms/phase/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `invert` | boolean | `true` | Invert |
| `angle` | number (-180 to 180, step 1), optional | — | Angle |

### Read FFmpeg

Read audio from a file using FFmpeg

[Source](./src/sources/read/ffmpeg/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `""` |  |
| `ffmpegPath` | string | `""` | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `ffprobePath` | string | `""` | FFprobe — media file analyzer (included with FFmpeg) Download: [ffprobe](https://ffmpeg.org/download.html) |

### Read WAV

Read audio from a WAV file

[Source](./src/sources/read/wav/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `""` |  |

### Reverse

Reverse audio playback direction

[Source](./src/transforms/reverse/index.ts)

### Spectrogram

Generate spectrogram visualization data

[Source](./src/targets/spectrogram/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `outputPath` | string | `""` | Output Path |
| `fftSize` | number (256 to 8192, step 256) | `2048` | FFT Size |
| `hopSize` | number (64 to 8192, step 64) | `512` | Hop Size |
| `fftwAddonPath` | string | `""` | FFTW Addon |

### Splice

Replace a region of audio with processed content

[Source](./src/transforms/splice/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `insertPath` | string | `""` | Insert File Path |
| `insertAt` | number (min 0) | `0` | Insert At (frames) |

### Trim

Remove silence from start and end

[Source](./src/transforms/trim/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `threshold` | number (0 to 1, step 0.001) | `0.001` | Threshold |
| `margin` | number (0 to 1, step 0.001) | `0.01` | Margin |
| `start` | boolean | `true` | Start |
| `end` | boolean | `true` | End |

### True Peak Normalize

Measure source true peak (4× upsampled, BS.1770-4 style) and apply a single linear gain to hit a target dBTP

[Source](./src/transforms/true-peak-normalize/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `target` | number (max 0) | `-1` | Target true peak (dBTP). Must be < 0. |

### VST3

Host a chain of VST3 effect plugins via Pedalboard (whole-file offline mode)

[Source](./src/transforms/vst3/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `vstHostPath` | string | `""` | vst-host — Pedalboard-based VST3 host CLI Download: [vst-host](https://github.com/visionsofparadise/vst-host) |
| `stages` | Object[] | — | Ordered chain of plugin/preset stages — processed end-to-end inside one Pedalboard offline call |
| `stages[].pluginPath` | string | — | VST3 plugin file or bundle |
| `stages[].pluginName` | string, optional | — | Sub-plugin name when pluginPath is a multi-plugin shell (e.g. WaveShell) |
| `stages[].presetPath` | string, optional | — | Optional .vstpreset state file applied after the plugin loads |
| `bypass` | boolean | `false` | Pass audio through unchanged (no subprocess spawn) |

### Waveform

Generate waveform visualization data

[Source](./src/targets/waveform/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `outputPath` | string | `""` | Output Path |
| `resolution` | number (100 to 10000, step 100) | `1000` | Resolution |

### Write

Write audio to a file

[Source](./src/targets/write/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `""` |  |
| `ffmpegPath` | string | `""` | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `bitDepth` | "16" \| "24" \| "32" \| "32f" | `"16"` |  |
| `encoding` | Object, optional | — | Encode through ffmpeg to a non-WAV format. Requires `ffmpegPath`. |
| `encoding.format` | "wav" \| "flac" \| "mp3" \| "aac" | — |  |
| `encoding.bitrate` | string, optional | — |  |
| `encoding.vbr` | number, optional | — |  |
| `encoding.sampleRate` | number (min 0), optional | — | Output sample rate (Hz). When set, ffmpeg resamples on encode. |

## Creating Nodes

Each node has two parts: a **Node** (inert descriptor) and a **Stream** (stateful runtime instance). The node is pure static declaration — `nodeName`, `description`, `schema`, `Stream`, plus `packageName` — and carries no per-render state. The executor constructs one stream per node per render.

Transforms extend one of two stream bases from `@buffered-audio/core`, picked by whether the node needs the whole signal (or fixed-size blocks) before it can produce output:

- **`UnbufferedTransformStream`** — per-block streaming (gain, pan, dither). One input block in, zero or more output blocks out.
- **`BufferedTransformStream`** — measure-then-apply and windowed DSP (normalize, loudness). Accumulates into a `BlockBuffer` sized by `blockSize` (default `WHOLE_FILE`), then serves.

### Stream Hooks

All output hooks are generators — `yield` a block to emit it, yield nothing to drop it. Production is paced by downstream demand (one `yield` served per pull).

- **`_transform`** — the core hook. Unbuffered: `*_transform(block)` runs once per input block. Buffered: `async *_transform(buffered: BlockBuffer)` runs once per assembled block (and once at end of stream with the trailing partial); walk the buffer with `buffered.iterate(frames)` and `yield` output.
- **`_prepare(block)`** (buffered only) — a length-preserving transform on each incoming block before it is buffered. Use it to fold a streaming measurement (peak, LUFS) on the way in.
- **`_flush()`** — a generator emitting trailing output at graceful end of stream, after the final `_transform`.
- **`_setup(context)`** — context-dependent initialization (subprocess, ONNX session, FFT workspace). Runs before piping.
- **`_pipe(input)`** — maps the input readable to the output; override to compose inner streams (e.g. wrap the transform in resamplers).
- **`_destroy()`** — cleanup on every termination path (graceful end, error, cancel), invoked at most once. Close file handles, free native resources, release ONNX sessions.

Report progress with `this.emitProgress(phase, framesDone, framesTotal?)` (pace it with `createProgressGate`) and structured logs with `this.log(message, data?, level?)`.

### blockSize Modes (buffered)

- `WHOLE_FILE` (`Infinity`, the default) — one firing at end of stream with the whole signal.
- `N` — block mode. `_transform` fires each time the buffer fills to `N` frames (short only at end of stream).

### Example: Normalize

```ts
import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BlockBuffer, type TransformNodeProperties } from "@buffered-audio/core";

export const schema = z.object({
	ceiling: z.number().min(0).max(1).multipleOf(0.01).default(1.0).describe("Ceiling"),
});

export interface NormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class NormalizeStream extends BufferedTransformStream<NormalizeNode> {
	override blockSize = WHOLE_FILE;

	private peak = 0;

	override _prepare(block: Block): Block {
		for (const channel of block.samples) {
			for (const sample of channel) this.peak = Math.max(this.peak, Math.abs(sample));
		}

		return block;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const scale = this.peak > 0 ? this.properties.ceiling / this.peak : 1;

		for await (const block of buffered.iterate(44100)) {
			if (scale === 1) {
				yield block;

				continue;
			}

			yield {
				samples: block.samples.map((channel) => channel.map((sample) => sample * scale)),
				offset: block.offset,
				sampleRate: block.sampleRate,
				bitDepth: block.bitDepth,
			};
		}
	}
}

export class NormalizeNode extends TransformNode<NormalizeProperties> {
	static override readonly nodeName = "Normalize";
	static override readonly packageName = "@buffered-audio/nodes";
	static override readonly description = "Adjust peak or loudness level to a target ceiling";
	static override readonly schema = schema;
	static override readonly Stream = NormalizeStream;
}

export function normalize(options?: { ceiling?: number; id?: string }): NormalizeNode {
	return new NormalizeNode(options ?? {});
}
```

## FFT Backends

Transforms that use spectral processing (STFT/iSTFT) can use native FFT backends for performance. The framework selects a backend based on the stream's `executionProviders` preference:

| Backend    | Provider     | Addon                                                           | Description                       |
| ---------- | ------------ | --------------------------------------------------------------- | --------------------------------- |
| VkFFT      | `gpu`        | [vkfft-addon](https://github.com/visionsofparadise/vkfft-addon) | GPU-accelerated FFT via Vulkan    |
| FFTW       | `cpu-native` | [fftw-addon](https://github.com/visionsofparadise/fftw-addon)   | Native CPU FFT                    |
| JavaScript | `cpu`        | Built-in                                                        | Pure JS fallback, no addon needed |

Pass addon paths via node properties (`vkfftAddonPath`, `fftwAddonPath`). Falls back to the built-in JavaScript implementation when no native addon is available.

## ONNX Models

ML-based transforms use ONNX Runtime for inference via a native addon. Nodes that use ONNX accept:

- `onnxAddonPath` — path to the [onnx-runtime-addon](https://github.com/visionsofparadise/onnx-runtime-addon) native binary
- `modelPath` — path to the `.onnx` model file

Models are not bundled with the package. Each node's parameter table links to the expected model source.

| Node            | Model                            | Source                                                                            |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| dtln            | model_1.onnx, model_2.onnx       | [DTLN](https://github.com/breizhn/DTLN)                                           |
| deepFilterNet3  | dfn3.onnx                        | [SpeechDenoiser](https://github.com/yuyun2000/SpeechDenoiser)                     |
| kimVocal2       | Kim_Vocal_2.onnx                 | [uvr_models](https://huggingface.co/seanghay/uvr_models)                          |
| htdemucs        | htdemucs.onnx + htdemucs.onnx.data | [demucs](https://github.com/facebookresearch/demucs)                            |

## License

ISC
