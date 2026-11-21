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

const source = read("input.wav");

chain(source, normalize({ ceiling: 0.95 }), write("output.wav", { bitDepth: "24" }));

await source.createRenderJob().render();
```

`createRenderJob()` builds a render job for the pipeline rooted at the source, and its `render()` streams audio through the chain. Backpressure, buffering, and lifecycle are handled by the framework.

### Fan-out

Split a stream into parallel branches by calling `.to()` multiple times from the same node:

```ts
import { read, normalize, trim, write } from "@buffered-audio/nodes";

const source = read("input.wav");
const normalizeNode = normalize();
const trimNode = trim();

source.to(normalizeNode);
source.to(trimNode);
normalizeNode.to(write("normalized.wav"));
trimNode.to(write("trimmed.wav"));

await source.createRenderJob().render();
```

## CLI

Render `.bag` files and run pipelines from the command line with [`@buffered-audio/cli`](https://www.npmjs.com/package/@buffered-audio/cli).

## Nodes

### CLI

Process audio through any command-line tool over stdin and stdout. The bag runs the named executable with full system access.

[Source](./src/transforms/cli/index.ts)

| Parameter          | Type                        | Default   | Description                                                                                                                                 |
| ------------------ | --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`          | string                      | `""`      | Executable to run: a path, or a bare name resolved through PATH. It runs without a shell, so Windows .cmd and .bat shims are not supported. |
| `args`             | string[]                    | `[]`      | Arguments for the command. {sampleRate} and {channels} become the input stream's sample rate and channel count.                             |
| `inputFormat`      | "wav" \| "f32le" \| "f64le" | `"f32le"` | Format written to the command's stdin: wav (32-bit float), f32le or f64le                                                                   |
| `outputFormat`     | "wav" \| "f32le" \| "f64le" | `"f32le"` | Format read from the command's stdout: wav, f32le or f64le                                                                                  |
| `outputSampleRate` | number (min 0), optional    | —         | Sample rate the command emits. Required when the command changes the rate.                                                                  |
| `outputChannels`   | number (min 0), optional    | —         | Channel count the command emits. Required when the command changes the channel count.                                                       |

### Cut

Remove a region of audio

[Source](./src/transforms/cut/index.ts)

| Parameter         | Type                | Default | Description     |
| ----------------- | ------------------- | ------- | --------------- |
| `regions`         | Object[]            | `[]`    | Regions         |
| `regions[].start` | number (0 to 86400) | —       | Start (seconds) |
| `regions[].end`   | number (0 to 86400) | —       | End (seconds)   |

### De-Bleed Adaptive

Adaptive (MEF FDAF Kalman + MWF + MSAD) reference-based microphone bleed reduction. Stages 1+2 are MEF Meyer-Elshamy-Fingscheidt 2020; Stage 3 is Lukin-Todd 2D NLM+DFTT post-filter.

[Source](./src/transforms/de-bleed/index.ts)

| Parameter           | Type                            | Default | Description                                                                                                         |
| ------------------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `references`        | string[]                        | `[]`    | References                                                                                                          |
| `reductionStrength` | number (0 to 10, step 0.1)      | `5`     | Reduction Strength                                                                                                  |
| `artifactSmoothing` | number (0 to 10, step 0.1)      | `5`     | Artifact Smoothing                                                                                                  |
| `adaptationSpeed`   | number (0 to 10, step 0.1)      | `3`     | Adaptation Speed                                                                                                    |
| `fftSize`           | number (512 to 16384, step 256) | `4096`  | FFT Size                                                                                                            |
| `hopSize`           | number (128 to 4096, step 64)   | `1024`  | Hop Size                                                                                                            |
| `vkfftAddonPath`    | string                          | `""`    | VkFFT native addon — GPU FFT acceleration Download: [vkfft-addon](https://github.com/visionsofparadise/vkfft-addon) |
| `fftwAddonPath`     | string                          | `""`    | FFTW native addon — CPU FFT acceleration Download: [fftw-addon](https://github.com/visionsofparadise/fftw-addon)    |
| `dfttBackend`       | "" \| "js" \| "fftw" \| "vkfft" | `""`    | DFTT Backend Override                                                                                               |

### DeepFilterNet3 (Denoiser)

Remove background noise from speech using DeepFilterNet3 (48 kHz full-band CRN). At other source rates, the internal resampling round trip may add or drop up to two source-rate frames.

[Source](./src/transforms/deep-filter-net-3/index.ts)

| Parameter       | Type              | Default | Description                                                                                                                                                                                        |
| --------------- | ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelPath`     | string            | `""`    | DeepFilterNet3 48 kHz denoiser model (.onnx) Download: [dfn3](https://github.com/yuyun2000/SpeechDenoiser)                                                                                         |
| `ffmpegPath`    | string            | `""`    | FFmpeg — used when the input audio is not 48 kHz to chain up/down resamplers around the inference stream; can be left blank for 48 kHz input. Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `onnxAddonPath` | string            | `""`    | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon)                                                                                          |
| `attenuation`   | number (0 to 100) | `30`    | Attenuation cap in dB. Maps to the ONNX `atten_lim_db` input; 0 = no cap                                                                                                                           |

### Dither

Add shaped noise to reduce quantization distortion

[Source](./src/transforms/dither/index.ts)

| Parameter      | Type     | Default | Description   |
| -------------- | -------- | ------- | ------------- |
| `bitDepth`     | 16 \| 24 | `16`    | Bit Depth     |
| `noiseShaping` | boolean  | `false` | Noise Shaping |

### Downmix Mono

Mix all input channels to a single mono channel by averaging

[Source](./src/transforms/downmix-mono/index.ts)

### DTLN (Denoiser)

Remove background noise from speech using DTLN neural network

[Source](./src/transforms/dtln/index.ts)

| Parameter        | Type   | Default | Description                                                                                                         |
| ---------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `modelPath1`     | string | `""`    | DTLN magnitude mask model (.onnx) Download: [dtln-model_1](https://github.com/breizhn/DTLN)                         |
| `modelPath2`     | string | `""`    | DTLN time-domain model (.onnx) Download: [dtln-model_2](https://github.com/breizhn/DTLN)                            |
| `ffmpegPath`     | string | `""`    | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html)                           |
| `onnxAddonPath`  | string | `""`    | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon)           |
| `vkfftAddonPath` | string | `""`    | VkFFT native addon — GPU FFT acceleration Download: [vkfft-addon](https://github.com/visionsofparadise/vkfft-addon) |
| `fftwAddonPath`  | string | `""`    | FFTW native addon — CPU FFT acceleration Download: [fftw-addon](https://github.com/visionsofparadise/fftw-addon)    |

### Duplicate Channels

Duplicate a mono signal into multiple identical output channels; requires exactly 1 input channel, throws otherwise

[Source](./src/transforms/duplicate-channels/index.ts)

| Parameter  | Type            | Default | Description          |
| ---------- | --------------- | ------- | -------------------- |
| `channels` | number (2 to 8) | `2`     | Output channel count |

### Faust

Compile Faust DSP source and stream audio through JIT instances

[Source](./src/transforms/faust/index.ts)

| Parameter        | Type   | Default | Description                                                                                                        |
| ---------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `code`           | string | —       | Faust DSP source; import("stdfaust.lib") is available                                                              |
| `faustAddonPath` | string | `""`    | Faust native addon — libfaust + LLVM JIT Download: [faust-addon](https://github.com/visionsofparadise/faust-addon) |

### FFmpeg

Process audio through FFmpeg filters

[Source](./src/transforms/ffmpeg/index.ts)

| Parameter          | Type                     | Default | Description                                                                                   |
| ------------------ | ------------------------ | ------- | --------------------------------------------------------------------------------------------- |
| `ffmpegPath`       | string                   | `""`    | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html)     |
| `args`             | string[]                 | `[]`    |                                                                                               |
| `outputSampleRate` | number (min 0), optional | —       | Sample rate of emitted chunks. Required when args change the rate (e.g. -af aresample=24000). |

### Gain

Adjust signal level by a fixed amount in dB

[Source](./src/transforms/gain/index.ts)

| Parameter | Type                         | Default | Description |
| --------- | ---------------------------- | ------- | ----------- |
| `gain`    | number (-60 to 24, step 0.1) | `0`     | Gain (dB)   |

### HTDemucs (Stem Separator)

Rebalance stem volumes using HTDemucs source separation

[Source](./src/transforms/htdemucs/index.ts)

| Parameter       | Type                          | Default | Description                                                                                                                                    |
| --------------- | ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelPath`     | string                        | `""`    | HTDemucs source separation model (.onnx) — requires .onnx.data file alongside Download: [htdemucs](https://github.com/facebookresearch/demucs) |
| `ffmpegPath`    | string                        | `""`    | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html)                                                      |
| `onnxAddonPath` | string                        | `""`    | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon)                                      |
| `highPass`      | number (0 to 500, step 10)    | `0`     | High Pass                                                                                                                                      |
| `lowPass`       | number (0 to 22050, step 100) | `0`     | Low Pass                                                                                                                                       |

### Kim Vocal 2 (Stem Separator)

Isolate dialogue from background using MDX-Net vocal separation

[Source](./src/transforms/kim-vocal-2/index.ts)

| Parameter       | Type                             | Default | Description                                                                                               |
| --------------- | -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `modelPath`     | string                           | `""`    | MDX-Net vocal isolation model (.onnx) Download: [Kim_Vocal_2](https://huggingface.co/seanghay/uvr_models) |
| `ffmpegPath`    | string                           | `""`    | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html)                 |
| `onnxAddonPath` | string                           | `""`    | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon) |
| `highPass`      | number (20 to 500, step 10)      | `80`    | High Pass                                                                                                 |
| `lowPass`       | number (1000 to 22050, step 100) | `20000` | Low Pass                                                                                                  |

### Loudness Normalize

Measure integrated loudness (BS.1770) and apply a single linear gain to hit a target LUFS — no limiting, no dynamics

[Source](./src/transforms/loudness-normalize/index.ts)

| Parameter | Type                        | Default | Description                       |
| --------- | --------------------------- | ------- | --------------------------------- |
| `target`  | number (-50 to 0, step 0.1) | `-16`   | Target integrated loudness (LUFS) |

### Loudness Stats

Measure integrated loudness, true peak, and loudness range per EBU R128, plus an amplitude-distribution histogram

[Source](./src/targets/loudness-stats/index.ts)

| Parameter     | Type           | Default | Description                                                    |
| ------------- | -------------- | ------- | -------------------------------------------------------------- |
| `bucketCount` | number (min 0) | `1024`  | Amplitude histogram bucket count                               |
| `outputPath`  | string         | `""`    | Output Path (JSON sidecar). Empty string disables file output. |

### Loudness Tool

Process audio through loudness-tool: tp-norm, lufs-norm, target or crest

[Source](./src/transforms/loudness-tool/index.ts)

| Parameter          | Type     | Default                        | Description                                                                                                                                                                                                          |
| ------------------ | -------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loudnessToolPath` | string   | `""`                           | loudness-tool — loudness measurement and processing CLI Download: [loudness-tool](https://github.com/visionsofparadise/loudness-tool/releases/latest)                                                                |
| `args`             | string[] | `["lufs-norm","--lufs","-23"]` | loudness-tool command and options, such as ["target", "--lufs", "-16", "--tp", "-1"]. The command is tp-norm, lufs-norm, target or crest. The node supplies the input, output, stream formats and scratch directory. |

### Normalize

Adjust peak or loudness level to a target ceiling

[Source](./src/transforms/normalize/index.ts)

| Parameter | Type                       | Default | Description |
| --------- | -------------------------- | ------- | ----------- |
| `ceiling` | number (0 to 1, step 0.01) | `1`     | Ceiling     |

### Pad

Add silence to start or end of audio

[Source](./src/transforms/pad/index.ts)

| Parameter | Type                          | Default | Description |
| --------- | ----------------------------- | ------- | ----------- |
| `before`  | number (0 to 300, step 0.001) | `0`     | Before      |
| `after`   | number (0 to 300, step 0.001) | `0`     | After       |

### Pan

Position mono signal in stereo field or adjust stereo balance; throws for inputs with more than 2 channels

[Source](./src/transforms/pan/index.ts)

| Parameter | Type                        | Default | Description                                      |
| --------- | --------------------------- | ------- | ------------------------------------------------ |
| `pan`     | number (-1 to 1, step 0.01) | `0`     | Pan (-1 = full left, 0 = center, 1 = full right) |

### Phase

Invert or rotate signal phase

[Source](./src/transforms/phase/index.ts)

| Parameter | Type                                   | Default | Description |
| --------- | -------------------------------------- | ------- | ----------- |
| `invert`  | boolean                                | `true`  | Invert      |
| `angle`   | number (-180 to 180, step 1), optional | —       | Angle       |

### Read FFmpeg

Read audio from a file using FFmpeg

[Source](./src/sources/read/ffmpeg/index.ts)

| Parameter     | Type   | Default | Description                                                                                                |
| ------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------- |
| `path`        | string | `""`    |                                                                                                            |
| `ffmpegPath`  | string | `""`    | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html)                  |
| `ffprobePath` | string | `""`    | FFprobe — media file analyzer (included with FFmpeg) Download: [ffprobe](https://ffmpeg.org/download.html) |

### Read WAV

Read audio from a WAV file

[Source](./src/sources/read/wav/index.ts)

| Parameter | Type   | Default | Description |
| --------- | ------ | ------- | ----------- |
| `path`    | string | `""`    |             |

### Reverse

Reverse audio playback direction

[Source](./src/transforms/reverse/index.ts)

### Silero VAD (Voice Gate)

Attenuate non-speech regions using Silero VAD speech detection

[Source](./src/transforms/silero-vad/index.ts)

| Parameter            | Type               | Default | Description                                                                                               |
| -------------------- | ------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `modelPath`          | string             | `""`    | Silero VAD model, 16 kHz sr-frozen (.onnx) Download: [silero-vad](https://github.com/snakers4/silero-vad) |
| `ffmpegPath`         | string             | `""`    | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html)                 |
| `onnxAddonPath`      | string             | `""`    | ONNX Runtime native addon Download: [onnx-addon](https://github.com/visionsofparadise/onnx-runtime-addon) |
| `threshold`          | number (0 to 1)    | `0.5`   | Speech probability above which the gate opens                                                             |
| `minSpeechDuration`  | number (min 0)     | `0.25`  | Shortest speech region kept, in seconds                                                                   |
| `minSilenceDuration` | number (min 0)     | `0.1`   | Silence required before the gate closes, in seconds                                                       |
| `speechPad`          | number (min 0)     | `0.03`  | Padding kept around each speech region, in seconds                                                        |
| `attack`             | number (min 0)     | `0.02`  | Fade-in before each speech region, in seconds                                                             |
| `release`            | number (min 0)     | `0.05`  | Fade-out after each speech region, in seconds                                                             |
| `attenuation`        | number (-120 to 0) | `-40`   | Gain applied outside speech regions, in dB                                                                |

### Spectrogram

Generate spectrogram visualization data

[Source](./src/targets/spectrogram/index.ts)

| Parameter       | Type                           | Default | Description |
| --------------- | ------------------------------ | ------- | ----------- |
| `outputPath`    | string                         | `""`    | Output Path |
| `fftSize`       | number (256 to 8192, step 256) | `2048`  | FFT Size    |
| `hopSize`       | number (64 to 8192, step 64)   | `512`   | Hop Size    |
| `fftwAddonPath` | string                         | `""`    | FFTW Addon  |

### Splice

Replace a region of audio with processed content

[Source](./src/transforms/splice/index.ts)

| Parameter    | Type                     | Default | Description        |
| ------------ | ------------------------ | ------- | ------------------ |
| `insertPath` | string                   | `""`    | Insert File Path   |
| `insertAt`   | number (0 to 1000000000) | `0`     | Insert At (frames) |

### Trim

Remove silence from start and end

[Source](./src/transforms/trim/index.ts)

| Parameter   | Type                        | Default | Description |
| ----------- | --------------------------- | ------- | ----------- |
| `threshold` | number (0 to 1, step 0.001) | `0.001` | Threshold   |
| `margin`    | number (0 to 1, step 0.001) | `0.01`  | Margin      |
| `start`     | boolean                     | `true`  | Start       |
| `end`       | boolean                     | `true`  | End         |

### True Peak Normalize

Measure source true peak (4× upsampled, BS.1770-4 style) and apply a single linear gain to hit a target dBTP

[Source](./src/transforms/true-peak-normalize/index.ts)

| Parameter | Type              | Default | Description                           |
| --------- | ----------------- | ------- | ------------------------------------- |
| `target`  | number (-24 to 0) | `-1`    | Target true peak (dBTP). Must be < 0. |

### VST3

Host a chain of VST3 effect plugins via Pedalboard (whole-file offline mode)

[Source](./src/transforms/vst3/index.ts)

| Parameter             | Type             | Default | Description                                                                                                   |
| --------------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `vstHostPath`         | string           | `""`    | vst-host — Pedalboard-based VST3 host CLI Download: [vst-host](https://github.com/visionsofparadise/vst-host) |
| `stages`              | Object[]         | —       | Ordered chain of plugin/preset stages — processed end-to-end inside one Pedalboard offline call               |
| `stages[].pluginPath` | string           | —       | VST3 plugin file or bundle                                                                                    |
| `stages[].pluginName` | string, optional | —       | Sub-plugin name when pluginPath is a multi-plugin shell (e.g. WaveShell)                                      |
| `stages[].presetPath` | string, optional | —       | Optional .vstpreset state file applied after the plugin loads                                                 |
| `bypass`              | boolean          | `false` | Pass audio through unchanged (no subprocess spawn)                                                            |

### Waveform

Generate waveform visualization data

[Source](./src/targets/waveform/index.ts)

| Parameter    | Type                            | Default | Description |
| ------------ | ------------------------------- | ------- | ----------- |
| `outputPath` | string                          | `""`    | Output Path |
| `resolution` | number (100 to 10000, step 100) | `1000`  | Resolution  |

### Write

Write audio to a file

[Source](./src/targets/write/index.ts)

| Parameter             | Type                              | Default | Description                                                                               |
| --------------------- | --------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `path`                | string                            | `""`    |                                                                                           |
| `ffmpegPath`          | string                            | `""`    | FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html) |
| `bitDepth`            | "16" \| "24" \| "32" \| "32f"     | `"16"`  |                                                                                           |
| `encoding`            | Object, optional                  | —       | Encode through ffmpeg to a non-WAV format. Requires `ffmpegPath`.                         |
| `encoding.format`     | "wav" \| "flac" \| "mp3" \| "aac" | —       |                                                                                           |
| `encoding.bitrate`    | number (8 to 1024), optional      | —       | Constant bitrate in kbps for MP3 and AAC. Defaults to 192 kbps.                           |
| `encoding.vbr`        | number (0 to 9), optional         | —       |                                                                                           |
| `encoding.sampleRate` | number (min 0), optional          | —       | Output sample rate (Hz). When set, ffmpeg resamples on encode.                            |

## Writing Files

The Write target writes to a temporary file beside its output, named `<stem>.partial-<pid>-<hex><ext>`, and renames it onto the output path once the render succeeds. An aborted or failed render leaves the output path untouched and removes the temporary file, and an encoder is killed before it can finalize.

- **Devices and FIFOs.** A device, FIFO or socket, or a symlink to one, is written directly with no temporary file. So is a reserved device name on Windows, such as `NUL` or `COM1.wav`, and any `\\.\` path.
- **Symlinks.** A symlink to a regular file is written through: the file it points to is replaced and the symlink stays. A dangling symlink is written through too, so the missing file it names is created and the symlink stays.
- **Rejected in setup.** An empty path, a path ending in a path separator, a directory, and an existing file the process cannot write each reject before any audio is read.
- **What a replaced file keeps.** On POSIX the new file keeps the old one's permission bits, but not its owner, its hard links or its ACLs. The temporary file needs write access to the output's directory.
- **No audio.** A render that delivers no audio writes a WAV output with only its header, and leaves an encoded output alone: no file is created, and an existing one stays as it was.
- **Mount points.** When the output is a mount point, or the rename would cross filesystems, the finished file is copied into the output in place instead. That copy runs to the end even if the render is aborted meanwhile, so the output is never left truncated.

## Child Processes

Every child process a node runs goes through the child-process layer of `@buffered-audio/core`, which spawns it with `windowsHide` true, drains its stderr and bounds its teardown. That covers the CLI base's child, which serves the CLI, FFmpeg and Loudness Tool nodes and the FFmpeg resamplers of the ONNX nodes, the Read FFmpeg source's `ffmpeg` and `ffprobe`, the Write target's encoder and the VST3 node's `vst-host`. The VST3 node's liveness sampler sits outside the layer: the `pidtree` and `pidusage` packages it uses run `ps`, or PowerShell on Windows, as children of their own.

The Write target and the VST3 node write their child's input through the layer's `writeChildInput`. The CLI base writes its child's input itself and waits on a full pipe through `waitForChildWritable`. When its tool exits 0 before the input has ended, it stops writing, drops the rest of the input and ends its output with what the tool wrote, without an error.

Each node picks the first signal that ends its child:

- **CLI base:** SIGKILL when its stream is aborted, cancelled or torn down by a failure elsewhere in the render, and SIGTERM with the 2 s grace only when its own child or decoding failed.
- **Read FFmpeg:** SIGKILL.
- **Write:** SIGKILL unless its close completed, and SIGTERM after it.
- **VST3:** SIGTERM and the grace for `vst-host`, on an abort as on every other path.

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
import {
	BufferedTransformStream,
	TransformNode,
	WHOLE_FILE,
	type Block,
	type BlockBuffer,
	type TransformNodeProperties,
} from "@buffered-audio/core";

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

| Node           | Model                              | Source                                                        |
| -------------- | ---------------------------------- | ------------------------------------------------------------- |
| dtln           | model_1.onnx, model_2.onnx         | [DTLN](https://github.com/breizhn/DTLN)                       |
| deepFilterNet3 | dfn3.onnx                          | [SpeechDenoiser](https://github.com/yuyun2000/SpeechDenoiser) |
| kimVocal2      | Kim_Vocal_2.onnx                   | [uvr_models](https://huggingface.co/seanghay/uvr_models)      |
| htdemucs       | htdemucs.onnx + htdemucs.onnx.data | [demucs](https://github.com/facebookresearch/demucs)          |
| sileroVad      | silero-vad.onnx                    | [silero-vad](https://github.com/snakers4/silero-vad)          |

## License

[MIT](LICENSE)
