/* eslint-disable barrel-files/avoid-barrel-files */
// Sources
export { read, ReadNode, type ReadProperties } from "./sources/read";
export { ReadWavNode, readWav, readSample, ReadWavStream, wavSchema, type ReadWavProperties } from "./sources/read/wav";
export { ReadFfmpegNode, readFfmpeg, ReadFfmpegStream, ffmpegSchema, type ReadFfmpegProperties } from "./sources/read/ffmpeg";

// Targets
export { loudnessStats, LoudnessStatsNode, LoudnessStatsStream, type LoudnessStats } from "./targets/loudness-stats";
export { spectrogram, SpectrogramNode, SpectrogramStream, type FrequencyScale, type SpectrogramProperties } from "./targets/spectrogram";
export { waveform, WaveformNode, WaveformStream, type WaveformProperties } from "./targets/waveform";
export { write, WriteNode, WriteStream, type EncodingOptions, type WavBitDepth, type WriteProperties } from "./targets/write";

// Transforms - basic
export { cut, CutNode, CutStream, type CutProperties, type CutRegion } from "./transforms/cut";
export { dither, DitherNode, DitherStream, type DitherProperties } from "./transforms/dither";
export { normalize, NormalizeNode, NormalizeStream, type NormalizeProperties } from "./transforms/normalize";
export { pad, PadNode, PadStream, type PadProperties } from "./transforms/pad";
export { invert, phase, PhaseNode, PhaseStream, type PhaseProperties } from "./transforms/phase";
export { reverse, ReverseNode, ReverseStream } from "./transforms/reverse";
export { splice, SpliceNode, SpliceStream, type SpliceProperties } from "./transforms/splice";
export { trim, TrimNode, TrimStream, type TrimProperties } from "./transforms/trim";

// Transforms - channel
export { downmixMono, DownmixMonoNode, DownmixMonoStream } from "./transforms/downmix-mono";
export { duplicateChannels, DuplicateChannelsNode, DuplicateChannelsStream, type DuplicateChannelsProperties } from "./transforms/duplicate-channels";
export { gain, GainNode, GainStream, type GainProperties } from "./transforms/gain";
export { pan, PanNode, PanStream, type PanProperties } from "./transforms/pan";

// Transforms - ffmpeg
export { ffmpeg, FfmpegNode, FfmpegStream, type FfmpegProperties } from "./transforms/ffmpeg";

// Transforms - loudness
export { loudnessTarget, LoudnessTargetNode, LoudnessTargetStream, type LoudnessTargetProperties } from "./transforms/loudness-target";
export { loudnessNormalize, LoudnessNormalizeNode, LoudnessNormalizeStream, type LoudnessNormalizeProperties } from "./transforms/loudness-normalize";
export { truePeakNormalize, TruePeakNormalizeNode, TruePeakNormalizeStream, type TruePeakNormalizeProperties } from "./transforms/true-peak-normalize";

// Transforms - hosted
export { deBleed, DeBleedNode, DeBleedStream, type DeBleedProperties } from "./transforms/de-bleed";
export { deepFilterNet3, DeepFilterNet3Node, DeepFilterNet3Stream, type DeepFilterNet3Properties } from "./transforms/deep-filter-net-3";
export { dtln, DtlnNode, DtlnStream, type DtlnProperties } from "./transforms/dtln";
export { htdemucs, HtdemucsNode, HtdemucsStream, type HtdemucsProperties, type StemGains } from "./transforms/htdemucs";
export { kimVocal2, KimVocal2Node, KimVocal2Stream, type KimVocal2Properties } from "./transforms/kim-vocal-2";
export { vst3, Vst3Node, Vst3Stream, type Vst3Properties } from "./transforms/vst3";

// Composites
export { chain, ChainNode } from "./composites/chain";
export { CompositeNode } from "@e9g/buffered-audio-nodes-core";
