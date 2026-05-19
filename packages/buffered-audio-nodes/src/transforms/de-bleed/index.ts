/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loops with bounds-checked typed array access */
import { z } from "zod";
import { BufferedTransformStream, ChunkBuffer, TransformNode, WHOLE_FILE, type AudioChunk, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { applyDfttSmoothing, applyNlmSmoothing, getFftAddon, initFftBackend, istft, stft, type FftBackend, type StftOutput, type StftResult } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { readToBuffer } from "../../utils/read-to-buffer";
import { accumulateTransferChunk, createTransferAccumulator, finalizeTransferFunction, findMaxRefPower, type TransferFunction } from "./utils/cross-spectral";
import { adaptationSpeedToMarkovForgetting, createKalmanState, kalmanUpdateFrame, type KalmanParams, type KalmanState } from "./utils/mef-kalman";
import { computeMwfMask, createInterfererPsdState, reductionStrengthToOversubtraction, updateInterfererPsd, updatePrevOutputPsd, type InterfererPsdState, type MwfParams } from "./utils/mef-mwf";
import { applyIspRestoration, computeMsadDecision, createIspState, createMsadChannelState, ISP_THRESHOLD_FRAMES, type IspState, type MsadChannelState } from "./utils/mef-msad";
import { coldStartSeed, validateTransferSeed } from "./utils/warmup";

// New parameter surface per design-de-bleed.md 2026-05-01 "New user parameter
// surface — `reductionStrength`, `artifactSmoothing`, `adaptationSpeed` over
// 0–10". `references` carries over the 2026-04-21 multi-reference decision.
// The old `referencePath` field is removed; old NLMS-era `filterLength` /
// `stepSize` stay removed.
export const schema = z.object({
	references: z.array(z.string()).default([]).describe("References"),
	reductionStrength: z.number().min(0).max(10).multipleOf(0.1).default(5).describe("Reduction Strength"),
	artifactSmoothing: z.number().min(0).max(10).multipleOf(0.1).default(5).describe("Artifact Smoothing"),
	adaptationSpeed: z.number().min(0).max(10).multipleOf(0.1).default(3).describe("Adaptation Speed"),
	fftSize: z.number().min(512).max(16384).multipleOf(256).default(4096).describe("FFT Size"),
	hopSize: z.number().min(128).max(4096).multipleOf(64).default(1024).describe("Hop Size"),
	vkfftAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "vkfft-addon", download: "https://github.com/visionsofparadise/vkfft-addon" })
		.describe("VkFFT native addon — GPU FFT acceleration"),
	fftwAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "fftw-addon", download: "https://github.com/visionsofparadise/fftw-addon" })
		.describe("FFTW native addon — CPU FFT acceleration"),
	dfttBackend: z.enum(["", "js", "fftw", "vkfft"]).default("").describe("DFTT Backend Override"),
});

export interface DeBleedProperties extends z.infer<typeof schema>, TransformNodeProperties {}

// Streaming chunked `_process` budget and carry constants. See
// design-de-bleed.md 2026-04-21 "Streaming chunked two-pass `_process`" for the
// per-chunk STFT matrix budget and 2026-04-21 "DFTT batched via addon 2D FFT"
// for the DFTT batched-buffer peak (~73 MB at default params) that motivates
// the 96 MB ceiling.
const BUDGET_BYTES = Number(process.env.DEBLEED_BUDGET_BYTES) || 96 * 1024 * 1024;
const MATRIX_COUNT = 5;
const FLOOR_FRAMES = 256;
const CEILING_FRAMES = Number(process.env.DEBLEED_CEILING_FRAMES) || 4096;
const MAX_CARRY_FRAMES = 32;
const STREAM_COPY_FRAMES = 44100;

// MEF parameter constants per design-de-bleed.md "2026-05-01: New user
// parameter surface" + "2026-05-01: Replace stages 1+2 with MEF".
//
//   λ = 0.3 · reductionStrength    (linear, default 1.5 at user 5)
//   A = 0.998^(2^((s−3)/3))        (default 0.998 at user 3)
//   β = 0.5                         (PSD temporal smoothing, MEF default)
//   warmupSeconds = 30              (~6× MEF's 2-s convergence time)
//   R/K = hopSize / fftSize         (MEF Eq. 23 factor; 0.25 at default 1024/4096)
//
// `K_kalman` (per-bin count for the Kalman state) is derived from `fftSize`
// per design-de-bleed.md "2026-05-01: Use existing fftSize=4096 STFT for MEF
// stages 1+2". Single internal constant referencing fftSize so a future move
// to a parallel-STFT design (Option B) is a one-place change.
const MEF_TEMPORAL_SMOOTHING = 0.5;
const WARMUP_SECONDS = 30;
const MWF_EPSILON = 1e-10;
const ARTIFACT_THRESHOLD_SCALE = 0.15; // user 0–10 × 0.15 → threshold 0–1.5 (matches legacy 0–15 × 0.1)

function computeChunkFrames(numBins: number): number {
	const rawFrames = Math.floor(BUDGET_BYTES / (MATRIX_COUNT * numBins * 4));

	return Math.max(FLOOR_FRAMES, Math.min(CEILING_FRAMES, rawFrames));
}

function allocateStftOutput(frames: number, numBins: number): StftOutput {
	return {
		real: new Float32Array(frames * numBins),
		imag: new Float32Array(frames * numBins),
	};
}

/**
 * Sequential window reader for the de-bleed STFT pipeline.
 *
 * Each de-bleed STFT "chunk" needs `winFrames * hopSize + (fftSize - hopSize)`
 * sample-domain samples covering a virtual signal that consists of:
 *   - `edgePadSamples` zeros (leading virtual edge pad)
 *   - `totalFrames` real samples from the underlying ChunkBuffer
 *   - `edgePadSamples` zeros (trailing virtual edge pad)
 *
 * Successive chunks step by `chunkFrames * hopSize` virtual samples and
 * overlap by `(winFrames - chunkFrames) * hopSize` samples on each side
 * (`carry * hopSize` on each side, except clipped at virtual edges).
 *
 * `WindowReader` reads from the underlying ChunkBuffer sequentially —
 * `await buffer.reset()` before instantiating, then call `advance()` once per
 * chunk to slide the per-channel scratch left by `step` samples and append the
 * next `step` samples (zero-padded if the buffer is exhausted). The reader
 * tracks its position in the virtual signal so the first chunk's scratch is
 * prefilled with `edgePadSamples` leading zeros, and the last chunks zero-fill
 * the trailing tail naturally when the buffer returns short reads.
 *
 * This replaces the previous offset-based `readChunkIntoPadded` helper. Both
 * the target and each reference buffer drive their own `WindowReader` advanced
 * in lockstep with the outer chunk loop.
 */
class WindowReader {
	private readonly scratch: Array<Float32Array>;
	private readonly windowSamples: number;
	private readonly channels: number;
	private virtualCursor = 0;
	private bufferDrained = false;

	constructor(channels: number, windowSamples: number) {
		this.channels = channels;
		this.windowSamples = windowSamples;
		this.scratch = [];
		for (let ch = 0; ch < channels; ch++) this.scratch.push(new Float32Array(windowSamples));
	}

	getScratch(): Array<Float32Array> {
		return this.scratch;
	}

	/** Fill the leading `edgePadSamples` of the virtual signal with zeros and load the rest of the first window from `buffer`. */
	async preload(buffer: ChunkBuffer, edgePadSamples: number): Promise<void> {
		for (let ch = 0; ch < this.channels; ch++) this.scratch[ch]!.fill(0);

		this.virtualCursor = 0;
		this.bufferDrained = false;

		const headPad = Math.min(edgePadSamples, this.windowSamples);
		const remainingInWindow = this.windowSamples - headPad;

		if (remainingInWindow > 0) await this.readInto(buffer, headPad, remainingInWindow);

		this.virtualCursor = this.windowSamples;
	}

	/** Slide scratch left by `step` samples; append `step` new samples from `buffer` (zero-filled past end). */
	async advance(buffer: ChunkBuffer, step: number): Promise<void> {
		if (step <= 0) return;

		const keep = this.windowSamples - step;

		for (let ch = 0; ch < this.channels; ch++) {
			const view = this.scratch[ch]!;

			if (keep > 0) view.copyWithin(0, step, this.windowSamples);
			view.fill(0, keep, this.windowSamples);
		}

		await this.readInto(buffer, keep, step);
		this.virtualCursor += step;
	}

	private async readInto(buffer: ChunkBuffer, writeOffset: number, length: number): Promise<void> {
		if (this.bufferDrained) return;

		let remaining = length;
		let outOffset = writeOffset;

		while (remaining > 0) {
			const chunk = await buffer.read(remaining);
			const chunkFrames = chunk.samples[0]?.length ?? 0;

			if (chunkFrames === 0) {
				this.bufferDrained = true;

				return;
			}

			for (let ch = 0; ch < this.channels; ch++) {
				const src = chunk.samples[ch];
				const dest = this.scratch[ch]!;

				if (src) dest.set(src.subarray(0, chunkFrames), outOffset);
			}

			outOffset += chunkFrames;
			remaining -= chunkFrames;
		}
	}
}

/**
 * Read `frames` STFT frames worth of samples from a sequential `ChunkBuffer`
 * (advances the read cursor by `frames * hopSize + (fftSize - hopSize)` samples
 * minus any leading virtual edge pad). Used by the one-shot warm-up pass.
 *
 * When `edgePadSamples > 0`, the file is treated as if it were virtually
 * extended by `edgePadSamples` zero samples at the start AND end. The first
 * `edgePadSamples` of `out` are left as zero; the remainder is filled from the
 * buffer (zero-padded if the buffer is shorter than requested).
 */
async function readSequentialPadded(
	chunkBuffer: ChunkBuffer,
	channelIndex: number,
	frames: number,
	out: Float32Array,
	hopSize: number,
	fftSize: number,
	edgePadSamples: number,
): Promise<void> {
	out.fill(0);

	const samplesRequired = frames * hopSize + (fftSize - hopSize);

	if (samplesRequired <= 0) return;

	const headPad = Math.min(edgePadSamples, samplesRequired);
	const remaining = samplesRequired - headPad;

	if (remaining <= 0) return;

	let written = 0;
	let toRead = remaining;

	while (toRead > 0) {
		const chunk = await chunkBuffer.read(toRead);
		const chunkFrames = chunk.samples[0]?.length ?? 0;

		if (chunkFrames === 0) return;

		const src = chunk.samples[channelIndex];

		if (src) out.set(src.subarray(0, chunkFrames), headPad + written);

		written += chunkFrames;
		toRead -= chunkFrames;
	}
}

/**
 * Adaptive de-bleed node — MEF FDAF Kalman + MWF + Lukin-Todd post-filter.
 *
 * Pipeline per design-de-bleed.md "2026-05-01: Replace stages 1+2 with MEF":
 *
 *   - **Stage 0 (MSAD)**: per-band SNR thresholding to gate Kalman update and
 *     trigger ISP restoration.
 *   - **Stage 1 (FDAF Kalman)**: per-frame frequency-domain Kalman update
 *     on `Ĥ_{m,μ}(ℓ,k)` per (target, reference) pair.
 *   - **Stage 2 (MWF)**: per-frame Wiener gain mask with per-interferer PSD
 *     `Φ̂_{D̂D̂,m} = |D̂_m^total|²` smoothed temporally (β = 0.5 MEF default).
 *   - **Stage 3 (NLM + DFTT)**: Lukin-Todd 2D smoothing of the gain mask.
 *   - **Stage 4 (synthesis)**: iSTFT of the masked target STFT.
 *
 * **IO pattern** (post chunk-buffer-sequential-api refactor): the target
 * `buffer` is treated as read-only during `_process`; a fresh `outputBuffer`
 * is allocated, all processed audio is streamed sequentially into it, then the
 * input buffer is cleared and the output is stream-copied back. The
 * `WindowReader` helper maintains a per-buffer sample-domain scratch that
 * advances in lockstep with the outer chunk loop — replacing the prior
 * offset-based reads against the input buffer. References use the same
 * `WindowReader` pattern, driven in lockstep with the target.
 *
 * **Outer-loop ordering**: all channels processed in lockstep per chunk
 * (option A from the Phase 6 plan). The per-channel algorithmic state
 * (Kalman, MWF PSD, MSAD, ISP) has no cross-channel coupling, so reordering
 * the inherent two nested loops from `for ch: for chunk` to
 * `for chunk: for ch` is a pure refactor with no algorithmic effect. This is
 * required by the new sequential ChunkBuffer API: `outputBuffer.write` stores
 * all channels at each frame position, so we must produce all channels'
 * samples for a given output frame range in one go.
 *
 * **Hard "do not extend" boundary** (Kokkinis): per-interferer PSD is
 * `|D̂^WF|²` from the Kalman bleed estimate ONLY. No PSD envelope of target,
 * no dominant-bin selection, no coherence-based interferer-PSD estimator.
 */
export class DeBleedStream extends BufferedTransformStream<DeBleedProperties> {
	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	private dfttFftBackend?: FftBackend;
	private dfttFftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	private referenceBuffers: Array<ChunkBuffer> = [];
	private chunkFrames!: number;
	private numBins!: number;

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<ReadableStream<AudioChunk>> {
		const fft = initFftBackend(context.executionProviders, this.properties);

		this.fftBackend = fft.backend;
		this.fftAddonOptions = fft.addonOptions;

		const { dfttBackend, fftwAddonPath, vkfftAddonPath } = this.properties;

		if (dfttBackend === "") {
			this.dfttFftBackend = fft.backend;
			this.dfttFftAddonOptions = fft.addonOptions;
		} else if (dfttBackend === "js") {
			this.dfttFftBackend = "js";
			this.dfttFftAddonOptions = undefined;
		} else if (dfttBackend === "fftw") {
			if (!fftwAddonPath) {
				throw new Error("de-bleed: dfttBackend='fftw' requires fftwAddonPath to be set on the node.");
			}

			this.dfttFftBackend = "fftw";
			this.dfttFftAddonOptions = { fftwPath: fftwAddonPath };

			const addon = getFftAddon("fftw", this.dfttFftAddonOptions);

			if (!addon) {
				throw new Error(`de-bleed: dfttBackend='fftw' could not load FFTW addon at ${fftwAddonPath}.`);
			}
		} else {
			// dfttBackend === "vkfft"
			if (!vkfftAddonPath) {
				throw new Error("de-bleed: dfttBackend='vkfft' requires vkfftAddonPath to be set on the node.");
			}

			this.dfttFftBackend = "vkfft";
			this.dfttFftAddonOptions = { vkfftPath: vkfftAddonPath };

			const addon = getFftAddon("vkfft", this.dfttFftAddonOptions);

			if (!addon) {
				throw new Error(`de-bleed: dfttBackend='vkfft' could not load VkFFT addon at ${vkfftAddonPath}.`);
			}
		}

		const openedBuffers: Array<ChunkBuffer> = [];

		try {
			for (const refPath of this.properties.references) {
				const { buffer: refBuffer } = await readToBuffer(refPath);

				openedBuffers.push(refBuffer);
			}

			this.referenceBuffers = openedBuffers;

			const { fftSize } = this.properties;

			this.numBins = fftSize / 2 + 1;
			this.chunkFrames = computeChunkFrames(this.numBins);

			return await super._setup(input, context);
		} catch (error) {
			for (const refBuffer of openedBuffers) {
				await refBuffer.close();
			}

			this.referenceBuffers = [];

			throw error;
		}
	}

	override async _teardown(): Promise<void> {
		for (const buffer of this.referenceBuffers) {
			await buffer.close();
		}

		this.referenceBuffers = [];
	}

	/**
	 * Run the first-N-seconds warm-up scan across all target channels and all
	 * references in a single sequential pass over each buffer.
	 *
	 * Each buffer is rewound to its start, then sequentially read for
	 * `warmupSamples` real samples. STFTs are computed once per buffer (one
	 * STFT per channel for the multi-channel target, one STFT per reference
	 * for the references). Per-channel cross-spectral accumulators then
	 * consume the pre-computed STFTs.
	 *
	 * Returns a `channels × refCount` array of `TransferFunction` seeds:
	 * `seedsByChannel[ch][refIndex]`. Degeneracy validation and cold-start
	 * fallback per `validateTransferSeed`.
	 */
	private async warmupSeedsAllChannels(
		buffer: ChunkBuffer,
		channels: number,
		warmupFrames: number,
		fftSize: number,
		hopSize: number,
	): Promise<Array<Array<TransferFunction>>> {
		const { numBins, referenceBuffers } = this;
		const refCount = referenceBuffers.length;

		if (warmupFrames <= 0 || refCount === 0) {
			return Array.from({ length: channels }, () => Array.from({ length: refCount }, () => coldStartSeed(numBins)));
		}

		const targetPaddeds = Array.from({ length: channels }, () => new Float32Array(warmupFrames * hopSize + (fftSize - hopSize)));
		const refPaddeds = Array.from({ length: refCount }, () => new Float32Array(warmupFrames * hopSize + (fftSize - hopSize)));

		await buffer.reset();
		for (let ch = 0; ch < channels; ch++) targetPaddeds[ch]!.fill(0);

		// Sequential read of the first `warmupSamples` real samples of the target
		// (all channels in one read pass), placed at offset 0 of each per-channel
		// padded buffer (no leading edge pad in warm-up).
		const targetSamples = warmupFrames * hopSize + (fftSize - hopSize);
		let written = 0;
		let toRead = Math.min(targetSamples, buffer.frames);

		while (toRead > 0) {
			const chunk = await buffer.read(toRead);
			const chunkFrames = chunk.samples[0]?.length ?? 0;

			if (chunkFrames === 0) break;

			for (let ch = 0; ch < channels; ch++) {
				const src = chunk.samples[ch];

				if (src) targetPaddeds[ch]!.set(src.subarray(0, chunkFrames), written);
			}

			written += chunkFrames;
			toRead -= chunkFrames;
		}

		// Each reference: read first warmup samples of channel 0.
		for (let refIndex = 0; refIndex < refCount; refIndex++) {
			await referenceBuffers[refIndex]!.reset();
			await readSequentialPadded(referenceBuffers[refIndex]!, 0, warmupFrames, refPaddeds[refIndex]!, hopSize, fftSize, 0);
		}

		// Compute STFTs: target × channels, references × refCount.
		const targetStftOutputs = Array.from({ length: channels }, () => allocateStftOutput(warmupFrames, numBins));
		const refStftOutputs = Array.from({ length: refCount }, () => allocateStftOutput(warmupFrames, numBins));

		const targetStfts = targetPaddeds.map((padded, ch) => stft(padded, fftSize, hopSize, targetStftOutputs[ch], this.fftBackend, this.fftAddonOptions));
		const refStfts = refPaddeds.map((padded, refIndex) => stft(padded, fftSize, hopSize, refStftOutputs[refIndex], this.fftBackend, this.fftAddonOptions));

		// Per-reference whole-file max |R|² (shared across all target channels).
		const maxRefPows = refStfts.map((refStft) => findMaxRefPower(refStft.real, refStft.imag, refStft.frames, numBins));
		const weightEpsilons = maxRefPows.map((maxPow) => 1e-10 * (maxPow + 1e-20));

		// Per-channel: accumulate cross-power against each reference and finalize.
		const seedsByChannel: Array<Array<TransferFunction>> = [];

		for (let ch = 0; ch < channels; ch++) {
			const targetStft = targetStfts[ch]!;
			const accumulators = refStfts.map(() => createTransferAccumulator(numBins));

			for (let refIndex = 0; refIndex < refCount; refIndex++) {
				const refStft = refStfts[refIndex]!;

				accumulateTransferChunk(targetStft.real, targetStft.imag, refStft.real, refStft.imag, targetStft.frames, numBins, weightEpsilons[refIndex]!, accumulators[refIndex]!);
			}

			const seeds = accumulators.map((acc) => finalizeTransferFunction(acc));
			const validated = seeds.map((seed) => {
				const validation = validateTransferSeed(seed);

				if (validation.degenerate) {

					console.warn(`de-bleed: warm-up seed degenerate (${validation.reason}); falling back to cold-start Ĥ(ℓ=0) = 0.`);

					return coldStartSeed(numBins);
				}

				return seed;
			});

			seedsByChannel.push(validated);
		}

		return seedsByChannel;
	}

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const { frames: totalFrames, channels, sampleRate, bitDepth } = buffer;
		const { fftSize, hopSize, reductionStrength, artifactSmoothing, adaptationSpeed } = this.properties;
		const { chunkFrames, numBins, referenceBuffers } = this;
		const refCount = referenceBuffers.length;

		if (totalFrames === 0 || channels === 0) return;

		// Per-stage timing accumulators — populated only when DEBLEED_PROFILE=1.
		const profileEnabled = process.env.DEBLEED_PROFILE === "1";
		const profileMs = { warmup: 0, stftRead: 0, msad: 0, kalman: 0, mwf: 0, nlm: 0, dftt: 0, applyMaskIstft: 0, write: 0 };
		const _profStart = (): number => profileEnabled ? performance.now() : 0;
		const _profAdd = (key: keyof typeof profileMs, t0: number): void => {
			if (profileEnabled) profileMs[key] += performance.now() - t0;
		};

		// MEF parameter mappings per the design's parameter-surface decision.
		const lambda = reductionStrengthToOversubtraction(reductionStrength);
		const markovForgetting = adaptationSpeedToMarkovForgetting(adaptationSpeed);
		const thresholdOverride = Number(process.env.DEBLEED_THRESHOLD);
		const threshold = thresholdOverride > 0 ? thresholdOverride : artifactSmoothing * ARTIFACT_THRESHOLD_SCALE;

		const kalmanParams: KalmanParams = {
			markovForgetting,
			temporalSmoothing: MEF_TEMPORAL_SMOOTHING,
			rOverK: hopSize / fftSize,
		};

		const mwfParams: MwfParams = {
			temporalSmoothing: MEF_TEMPORAL_SMOOTHING,
			oversubtraction: lambda,
		};

		const carry = MAX_CARRY_FRAMES;

		// Edge pad for the process pass. The iSTFT OLA windowSum is partial
		// within `(fftSize - hopSize)` samples of any signal boundary; we
		// virtually extend the file with `edgePadSamples` zeros at start AND
		// end. The iSTFT then reconstructs `[0, totalFrames)` from a fully-
		// determined windowSum and no edge-guard trim is needed.
		const edgePadSamples = fftSize - hopSize;
		const virtualTotal = totalFrames + 2 * edgePadSamples;
		const virtualLogicalLength = Math.max(virtualTotal, fftSize);
		const virtualPaddedLength = virtualLogicalLength + ((hopSize - ((virtualLogicalLength - fftSize) % hopSize)) % hopSize);
		const processStftFrames = Math.floor((virtualPaddedLength - fftSize) / hopSize) + 1;

		// Warm-up scan: first WARMUP_SECONDS of audio, capped to total file length.
		const effectiveSampleRate = sampleRate ?? 48000;
		const warmupSamples = Math.min(WARMUP_SECONDS * effectiveSampleRate, totalFrames);
		const warmupFrames = Math.max(0, Math.floor((warmupSamples - fftSize) / hopSize) + 1);

		// --- Warm-up scan across all target channels and references ---
		const _twarm = _profStart();
		const seedsByChannel = await this.warmupSeedsAllChannels(buffer, channels, warmupFrames, fftSize, hopSize);

		_profAdd("warmup", _twarm);

		// Rewind buffers for the main streaming pass.
		await buffer.reset();
		for (const refBuffer of referenceBuffers) await refBuffer.reset();

		// --- Allocate per-channel state ---
		const kalmanStatesByCh: Array<Array<KalmanState>> = seedsByChannel.map((seeds) => seeds.map((seed) => createKalmanState(numBins, seed)));
		const interfererPsdByCh: Array<InterfererPsdState> = Array.from({ length: channels }, () => createInterfererPsdState(numBins));
		const msadChannelStatesByCh: Array<Array<MsadChannelState>> = Array.from({ length: channels }, () => Array.from({ length: refCount + 1 }, () => createMsadChannelState(numBins)));
		const ispStatesByCh: Array<Array<IspState>> = Array.from({ length: channels }, () => Array.from({ length: refCount }, () => createIspState(numBins)));

		// MSAD ISP threshold: 0.5-s pause threshold per MEF §4.1.
		const ispThresholdFrames = sampleRate ? Math.max(1, Math.round(0.5 * sampleRate / hopSize)) : ISP_THRESHOLD_FRAMES;

		const windowFrames = chunkFrames + 2 * carry;
		const windowSamples = windowFrames * hopSize + (fftSize - hopSize);

		// Per-channel + per-reference STFT-output and intermediate scratch buffers.
		// Allocate once; reused across chunks. Per-channel arrays because
		// processing happens per-channel within each chunk and we want each
		// channel's STFT data to be independent.
		const targetStftOutputs: Array<StftOutput> = Array.from({ length: channels }, () => allocateStftOutput(windowFrames, numBins));
		const refStftOutputs: Array<StftOutput> = Array.from({ length: refCount }, () => allocateStftOutput(windowFrames, numBins));
		const rawMask = new Float32Array(windowFrames * numBins);
		const nlmMask = new Float32Array(windowFrames * numBins);
		const finalMask = new Float32Array(windowFrames * numBins);

		// Window readers for the target (multi-channel) and each reference (mono read).
		const targetReader = new WindowReader(channels, windowSamples);
		const refReaders: Array<WindowReader> = referenceBuffers.map(() => new WindowReader(1, windowSamples));

		await targetReader.preload(buffer, edgePadSamples);
		for (let refIndex = 0; refIndex < refCount; refIndex++) {
			await refReaders[refIndex]!.preload(referenceBuffers[refIndex]!, edgePadSamples);
		}

		// Per-frame scratch buffers for the Kalman + MWF inner loop.
		const refFrameReals = new Array<Float32Array>(refCount);
		const refFrameImags = new Array<Float32Array>(refCount);
		const bleedTotalReal = new Float32Array(numBins);
		const bleedTotalImag = new Float32Array(numBins);

		// Scratch arrays for MSAD per-frame channel-bin views — `[target, ref0, ref1, ...]`.
		const msadFrameReals = new Array<Float32Array>(refCount + 1);
		const msadFrameImags = new Array<Float32Array>(refCount + 1);

		// Output buffer — sequential writes only. After the channel loop, the
		// input buffer is cleared and outputBuffer is stream-copied back.
		const outputBuffer = new ChunkBuffer();

		try {
			let prevWinStart = 0;

			for (let outStart = 0; outStart < processStftFrames; outStart += chunkFrames) {
				const outFramesThisChunk = Math.min(chunkFrames, processStftFrames - outStart);
				const winStart = Math.max(0, outStart - carry);
				const winEnd = Math.min(processStftFrames, outStart + outFramesThisChunk + carry);
				const winFrames = winEnd - winStart;
				const winSamples = winFrames * hopSize + (fftSize - hopSize);

				// Advance the readers so their scratch covers the virtual sample
				// range [winStart * hopSize, winStart * hopSize + windowSamples).
				// `windowSamples` is the steady-state scratch length (winFrames at
				// its max = chunkFrames + 2*carry); at the first/last chunks where
				// `winFrames < chunkFrames + 2*carry`, the scratch holds more
				// samples than `winSamples` — we slice down below.
				if (outStart !== 0) {
					const stepFrames = winStart - prevWinStart;
					const stepSamples = stepFrames * hopSize;

					if (stepSamples > 0) {
						const _tadvance = _profStart();

						await targetReader.advance(buffer, stepSamples);
						for (let refIndex = 0; refIndex < refCount; refIndex++) {
							await refReaders[refIndex]!.advance(referenceBuffers[refIndex]!, stepSamples);
						}

						_profAdd("stftRead", _tadvance);
					}
				}

				prevWinStart = winStart;

				// --- Compute target STFT per channel; reference STFTs ---
				const _tstft = _profStart();
				const targetScratch = targetReader.getScratch();
				const targetStfts: Array<StftResult> = [];

				for (let ch = 0; ch < channels; ch++) {
					const stftOut = stft(targetScratch[ch]!.subarray(0, winSamples), fftSize, hopSize, targetStftOutputs[ch], this.fftBackend, this.fftAddonOptions);

					targetStfts.push(stftOut);
				}

				const refStftsForChunk: Array<StftResult> = [];

				for (let refIndex = 0; refIndex < refCount; refIndex++) {
					const refScratch = refReaders[refIndex]!.getScratch();
					const refStft = stft(refScratch[0]!.subarray(0, winSamples), fftSize, hopSize, refStftOutputs[refIndex], this.fftBackend, this.fftAddonOptions);

					refStftsForChunk.push(refStft);
				}

				_profAdd("stftRead", _tstft);

				// --- Per-channel iSTFT output collection for this chunk ---
				// Each entry is the iSTFT result Float32Array (length = winSamples)
				// per channel. After all channels are processed for this chunk we
				// extract the center samples and stream-write them as multi-channel
				// frames to outputBuffer.
				const cleanedByChannel: Array<Float32Array> = [];

				// Per-frame scratch buffers for `Ŝ_m = W · Y_m`. One pair per
				// channel because the channel loop runs within the chunk.
				const sHatRe = new Float32Array(numBins);
				const sHatIm = new Float32Array(numBins);

				for (let ch = 0; ch < channels; ch++) {
					const kalmanStates = kalmanStatesByCh[ch]!;
					const interfererPsd = interfererPsdByCh[ch]!;
					const msadChannelStates = msadChannelStatesByCh[ch]!;
					const ispStates = ispStatesByCh[ch]!;
					const targetStft = targetStfts[ch]!;

					for (let frame = 0; frame < winFrames; frame++) {
						const frameOffset = frame * numBins;
						const frameReal = targetStft.real.subarray(frameOffset, frameOffset + numBins);
						const frameImag = targetStft.imag.subarray(frameOffset, frameOffset + numBins);

						for (let refIndex = 0; refIndex < refCount; refIndex++) {
							refFrameReals[refIndex] = refStftsForChunk[refIndex]!.real.subarray(frameOffset, frameOffset + numBins);
							refFrameImags[refIndex] = refStftsForChunk[refIndex]!.imag.subarray(frameOffset, frameOffset + numBins);
						}

						// --- Stage 0: MSAD ---
						msadFrameReals[0] = frameReal;
						msadFrameImags[0] = frameImag;

						for (let refIndex = 0; refIndex < refCount; refIndex++) {
							msadFrameReals[refIndex + 1] = refFrameReals[refIndex]!;
							msadFrameImags[refIndex + 1] = refFrameImags[refIndex]!;
						}

						const _tmsad = _profStart();
						const msadDecision = computeMsadDecision(msadFrameReals, msadFrameImags, msadChannelStates);

						_profAdd("msad", _tmsad);

						// --- Stage 1: FDAF Kalman ---
						const _tkal = _profStart();

						kalmanUpdateFrame(
							frameReal,
							frameImag,
							refFrameReals,
							refFrameImags,
							kalmanStates,
							kalmanParams,
							bleedTotalReal,
							bleedTotalImag,
							msadDecision.targetActive,
						);

						for (let refIndex = 0; refIndex < refCount; refIndex++) {
							applyIspRestoration(kalmanStates[refIndex]!, ispStates[refIndex]!, msadDecision.referenceActive[refIndex]!, ispThresholdFrames);
						}

						_profAdd("kalman", _tkal);

						// --- Stage 2: MWF ---
						const _tmwf = _profStart();

						updateInterfererPsd(bleedTotalReal, bleedTotalImag, interfererPsd, mwfParams.temporalSmoothing);

						const maskFrame = rawMask.subarray(frameOffset, frameOffset + numBins);

						computeMwfMask(frameReal, frameImag, bleedTotalReal, bleedTotalImag, interfererPsd, mwfParams, MWF_EPSILON, maskFrame);

						for (let bin = 0; bin < numBins; bin++) {
							const gain = maskFrame[bin]!;

							sHatRe[bin] = gain * frameReal[bin]!;
							sHatIm[bin] = gain * frameImag[bin]!;
						}

						updatePrevOutputPsd(sHatRe, sHatIm, interfererPsd);
						_profAdd("mwf", _tmwf);
					}

					// --- Stage 3: NLM + DFTT ---
					const rawView = rawMask.subarray(0, winFrames * numBins);
					const nlmView = nlmMask.subarray(0, winFrames * numBins);
					const finalView = finalMask.subarray(0, winFrames * numBins);

					const _tnlm = _profStart();

					applyNlmSmoothing(
						rawView,
						winFrames,
						numBins,
						{
							patchSize: 8,
							searchFreqRadius: 8,
							searchTimePre: 16,
							searchTimePost: 4,
							pasteBlockSize: Number(process.env.DEBLEED_NLM_PASTE) || 8,
							threshold,
						},
						nlmView,
					);
					_profAdd("nlm", _tnlm);

					const _tdftt = _profStart();

					applyDfttSmoothing(
						nlmView,
						rawView,
						winFrames,
						numBins,
						{
							blockFreq: 32,
							blockTime: 16,
							hopFreq: 8,
							hopTime: 4,
							threshold,
						},
						finalView,
						this.dfttFftBackend,
						this.dfttFftAddonOptions,
					);
					_profAdd("dftt", _tdftt);

					// --- Stage 4: apply mask, iSTFT ---
					const _tapp = _profStart();
					const targetRealBuf = targetStft.real;
					const targetImagBuf = targetStft.imag;

					for (let frame = 0; frame < winFrames; frame++) {
						const frameOffset = frame * numBins;

						for (let bin = 0; bin < numBins; bin++) {
							const gain = finalView[frameOffset + bin]!;

							targetRealBuf[frameOffset + bin] = targetRealBuf[frameOffset + bin]! * gain;
							targetImagBuf[frameOffset + bin] = targetImagBuf[frameOffset + bin]! * gain;
						}
					}

					const cleaned = istft(targetStft, hopSize, winSamples, this.fftBackend, this.fftAddonOptions);

					cleanedByChannel.push(cleaned);
					_profAdd("applyMaskIstft", _tapp);
				}

				// --- Stream-write all channels' center samples for this chunk to outputBuffer ---
				const centerStartFrame = outStart - winStart;
				const centerStartSample = centerStartFrame * hopSize;
				const isFinalChunk = outStart + outFramesThisChunk >= processStftFrames;
				const cleanedLength = cleanedByChannel[0]!.length;
				const centerEndSample = isFinalChunk ? cleanedLength : (centerStartFrame + outFramesThisChunk) * hopSize;

				// Map the virtual write range back to real-file samples by subtracting
				// the leading edge pad.
				const virtualWriteStart = winStart * hopSize + centerStartSample;
				const realWriteStart = virtualWriteStart - edgePadSamples;
				const realWriteEnd = realWriteStart + (centerEndSample - centerStartSample);
				const clipStart = Math.max(0, realWriteStart);
				const clipEnd = Math.min(totalFrames, realWriteEnd);

				if (clipEnd <= clipStart) continue;

				const sliceFromOffset = (clipStart - realWriteStart) + centerStartSample;
				const sliceLength = clipEnd - clipStart;
				const writeSamplesByChannel: Array<Float32Array> = [];

				for (let ch = 0; ch < channels; ch++) {
					writeSamplesByChannel.push(cleanedByChannel[ch]!.subarray(sliceFromOffset, sliceFromOffset + sliceLength));
				}

				// `outputBuffer` is written from `clipStart` in real-file coords. The
				// sequential API has no offset; we instead rely on the writes arriving
				// in monotonically increasing order across the outer loop. For chunks
				// where `clipStart > prevClipEnd` (the edge pad zone in the first chunk
				// produced no writes but later chunks have realWriteStart > 0), we
				// pad with zero frames to keep the output buffer's frame count aligned
				// with real-file frame positions.
				if (clipStart > outputBuffer.frames) {
					const padFrames = clipStart - outputBuffer.frames;
					const zeroSamples: Array<Float32Array> = [];

					for (let ch = 0; ch < channels; ch++) zeroSamples.push(new Float32Array(padFrames));

					const _twritePad = _profStart();

					await outputBuffer.write(zeroSamples, sampleRate, bitDepth);
					_profAdd("write", _twritePad);
				}

				const _twrite = _profStart();

				await outputBuffer.write(writeSamplesByChannel, sampleRate, bitDepth);
				_profAdd("write", _twrite);
			}

			// Trailing zero-pad if the output ended short of totalFrames (shouldn't
			// normally happen — processStftFrames covers virtualTotal — but
			// defensive against off-by-one at the final chunk's clip math).
			if (outputBuffer.frames < totalFrames) {
				const padFrames = totalFrames - outputBuffer.frames;
				const zeroSamples: Array<Float32Array> = [];

				for (let ch = 0; ch < channels; ch++) zeroSamples.push(new Float32Array(padFrames));

				await outputBuffer.write(zeroSamples, sampleRate, bitDepth);
			}

			// --- Stream-copy outputBuffer → buffer ---
			await buffer.clear();
			await outputBuffer.reset();

			for (;;) {
				const chunk = await outputBuffer.read(STREAM_COPY_FRAMES);
				const chunkFramesRead = chunk.samples[0]?.length ?? 0;

				if (chunkFramesRead === 0) break;

				await buffer.write(chunk.samples, sampleRate, bitDepth);

				if (chunkFramesRead < STREAM_COPY_FRAMES) break;
			}
		} finally {
			await outputBuffer.close();
		}

		if (profileEnabled) {
			const total = profileMs.warmup + profileMs.stftRead + profileMs.msad + profileMs.kalman + profileMs.mwf + profileMs.nlm + profileMs.dftt + profileMs.applyMaskIstft + profileMs.write;
			const pct = (key: keyof typeof profileMs): string => `${(profileMs[key] / 1000).toFixed(2)}s (${((profileMs[key] / total) * 100).toFixed(1)}%)`;

			// eslint-disable-next-line no-console -- profile output is opt-in via env var
			console.log(`[deBleed profile]
  warmup        : ${pct("warmup")}
  stft+read     : ${pct("stftRead")}
  msad          : ${pct("msad")}
  kalman+isp    : ${pct("kalman")}
  mwf           : ${pct("mwf")}
  nlm           : ${pct("nlm")}
  dftt          : ${pct("dftt")}
  applyMask+istft: ${pct("applyMaskIstft")}
  write         : ${pct("write")}
  TOTAL         : ${(total / 1000).toFixed(2)}s`);
		}
	}
}

export class DeBleedNode extends TransformNode<DeBleedProperties> {
	static override readonly moduleName = "De-Bleed Adaptive";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Adaptive (MEF FDAF Kalman + MWF + MSAD) reference-based microphone bleed reduction. Stages 1+2 are MEF Meyer-Elshamy-Fingscheidt 2020; Stage 3 is Lukin-Todd 2D NLM+DFTT post-filter.";
	static override readonly schema = schema;
	static override is(value: unknown): value is DeBleedNode {
		return TransformNode.is(value) && value.type[2] === "de-bleed";
	}

	override readonly type = ["buffered-audio-node", "transform", "de-bleed"] as const;

	constructor(properties: DeBleedProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): DeBleedStream {
		return new DeBleedStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<DeBleedProperties>): DeBleedNode {
		return new DeBleedNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function deBleed(
	references: string | ReadonlyArray<string>,
	options?: {
		reductionStrength?: number;
		artifactSmoothing?: number;
		adaptationSpeed?: number;
		fftSize?: number;
		hopSize?: number;
		vkfftAddonPath?: string;
		fftwAddonPath?: string;
		dfttBackend?: "" | "js" | "fftw" | "vkfft";
		id?: string;
	},
): DeBleedNode {
	const referencesArray = typeof references === "string" ? [references] : [...references];

	return new DeBleedNode({
		references: referencesArray,
		reductionStrength: options?.reductionStrength ?? 5,
		artifactSmoothing: options?.artifactSmoothing ?? 5,
		adaptationSpeed: options?.adaptationSpeed ?? 3,
		fftSize: options?.fftSize ?? 4096,
		hopSize: options?.hopSize ?? 1024,
		vkfftAddonPath: options?.vkfftAddonPath ?? "",
		fftwAddonPath: options?.fftwAddonPath ?? "",
		dfttBackend: options?.dfttBackend ?? "",
		id: options?.id,
	});
}
