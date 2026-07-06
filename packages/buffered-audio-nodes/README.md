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

### `process`

Run pipelines from TypeScript files. The file's default export must be a `SourceNode`.

```bash
npx @buffered-audio/nodes process --pipeline pipeline.ts
```

```ts
// pipeline.ts
import { chain, read, normalize, trim, write } from "@buffered-audio/nodes";

export default chain(read("input.wav"), normalize(), trim({ threshold: -60 }), write("output.wav"));
```

### `render`

Render a `.bag` (Buffered Audio Graph) file. BAG files are JSON-serialized graph definitions.

```bash
npx @buffered-audio/nodes render pipeline.bag
```

| Flag                        | Description                                                  |
| --------------------------- | ----------------------------------------------------------- |
| `--chunk-size <samples>`    | Chunk size in samples                                       |
| `--high-water-mark <count>` | Stream backpressure high water mark                         |
| `--param <name=value>`      | Bind a `{{name}}` template placeholder (repeatable)         |

#### Template parameters

String values in a bag's node `parameters` may contain `{{name}}` placeholders. Each `--param name=value` binds one for that render; the same bag renders different inputs and outputs without editing the file. Every placeholder must be bound, and every `--param` must match a placeholder, or the render fails before any audio work.

```json
{ "id": "a", "packageName": "@buffered-audio/nodes", "packageVersion": "0.16.0", "nodeName": "Read",  "parameters": { "path": "{{episode}}/raw.wav" } }
{ "id": "z", "packageName": "@buffered-audio/nodes", "packageVersion": "0.16.0", "nodeName": "Write", "parameters": { "path": "{{episode}}/master.wav" } }
```

```bash
npx @buffered-audio/nodes render master.bag --param episode=./e260
```

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

### Read

Read audio from a file

[Source](./src/sources/read/index.ts)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `""` |  |
| `ffmpegPath` | string | `""` | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `ffprobePath` | string | `""` | FFprobe — media file analyzer (included with FFmpeg) Download: [ffprobe](https://ffmpeg.org/download.html) |

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

Each node has two parts: a **Node** (inert descriptor) and a **Stream** (stateful runtime instance). Nodes are defined once and describe the transform. Streams are created fresh per render and hold the mutable processing state.

Extend `TransformNode` from `@buffered-audio/core` and create a companion `BufferedTransformStream`. The node's `createStream()` method produces a new stream instance for each render.

### Stream Hooks

- **`_buffer(chunk, buffer)`** — called for each incoming chunk. Override to inspect or modify data as it's buffered. Default appends to the buffer.
- **`_process(buffer)`** — called once the buffer reaches `bufferSize`. Use this for analysis or in-place modification of the full buffer.
- **`_unbuffer(chunk)`** — called for each chunk emitted from the buffer. Transform or replace the chunk here. Return `undefined` to drop it.
- **`_teardown()`** — cleanup after render completes. Close file handles, free native resources, release ONNX sessions. Called automatically on all streams.

### Buffer Size Modes

- `0` — pass-through. Each chunk flows through `_unbuffer` immediately.
- `N` — block mode. Chunks accumulate until `N` frames are collected, then `_process` runs and `_unbuffer` emits the result.
- `WHOLE_FILE` (`Infinity`) — full-file. All audio is buffered before `_process` and `_unbuffer` run.

### Example: Normalize

```ts
import { z } from "zod";
import { BufferedTransformStream, TransformNode, WHOLE_FILE, type AudioChunk, type ChunkBuffer, type TransformNodeProperties } from "@buffered-audio/core";

const schema = z.object({
	ceiling: z.number().min(0).max(1).multipleOf(0.01).default(1.0).describe("Ceiling"),
});

interface NormalizeProperties extends z.infer<typeof schema>, TransformNodeProperties {}

class NormalizeStream extends BufferedTransformStream<NormalizeProperties> {
	private peak = 0;
	private scale = 1;

	override async _buffer(chunk: AudioChunk, buffer: ChunkBuffer): Promise<void> {
		await super._buffer(chunk, buffer);

		for (let ch = 0; ch < chunk.samples.length; ch++) {
			const channel = chunk.samples[ch] ?? new Float32Array(0);

			for (let si = 0; si < channel.length; si++) {
				const absolute = Math.abs(channel[si] ?? 0);

				if (Number.isFinite(absolute) && absolute > this.peak) this.peak = absolute;
			}
		}
	}

	override _process(_buffer: ChunkBuffer): void {
		const raw = this.peak === 0 ? 1 : this.properties.ceiling / this.peak;

		this.scale = Number.isFinite(raw) ? raw : 1;
	}

	override _unbuffer(chunk: AudioChunk): AudioChunk {
		if (this.scale === 1) return chunk;

		const scaledSamples = chunk.samples.map((channel) => {
			const scaled = new Float32Array(channel.length);

			for (let index = 0; index < channel.length; index++) {
				scaled[index] = (channel[index] ?? 0) * this.scale;
			}

			return scaled;
		});

		return { samples: scaledSamples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

class NormalizeNode extends TransformNode<NormalizeProperties> {
	static override readonly nodeName = "Normalize";
	static override readonly packageName = "buffered-audio-nodes";
	static override readonly nodeDescription = "Adjust peak or loudness level to a target ceiling";
	static override readonly schema = schema;

	override readonly type = ["buffered-audio-node", "transform", "normalize"] as const;

	constructor(properties: NormalizeProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): NormalizeStream {
		return new NormalizeStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<NormalizeProperties>): NormalizeNode {
		return new NormalizeNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function normalize(options?: { ceiling?: number; id?: string }): NormalizeNode {
	return new NormalizeNode({ ceiling: options?.ceiling ?? 1.0, id: options?.id });
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
