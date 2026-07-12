/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loops with bounds-checked typed array access */
import { z } from "zod";
import { BufferedTransformStream, BlockBuffer, createProgressGate, TransformNode, WHOLE_FILE, type Block, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { applyDfttSmoothing, getFftAddon, initFftBackend, istft, stft, type FftBackend, type StftOutput, type StftResult } from "@buffered-audio/utils";
import { PACKAGE_NAME } from "../../package-metadata";
import { readToBuffer } from "../../utils/read-to-buffer";
import { accumulateTransferChunk, createTransferAccumulator, finalizeTransferFunction, findMaxRefPower, type TransferFunction } from "./utils/cross-spectral";
import { adaptationSpeedToMarkovForgetting, createKalmanState, kalmanUpdateFrame, type KalmanParams, type KalmanState } from "./utils/mef-kalman";
import { computeMwfMask, createInterfererPsdState, reductionStrengthToOversubtraction, updateInterfererPsd, updatePrevOutputPsd, type InterfererPsdState, type MwfParams } from "./utils/mef-mwf";
import { applyIspRestoration, computeMsadDecision, createIspState, createMsadChannelState, ISP_THRESHOLD_FRAMES, type IspState, type MsadChannelState } from "./utils/mef-msad";
import { coldStartSeed, validateTransferSeed } from "./utils/warmup";
import { WindowReader } from "./utils/window-reader";
import { computeChunkWindow, computeProcessGeometry, computeWriteClip } from "./utils/geometry";
import { createNlmWorkerPool, type NlmWorkerPool } from "./nlm-worker-pool";

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

const BUDGET_BYTES = Number(process.env.DEBLEED_BUDGET_BYTES) || 96 * 1024 * 1024;
const MATRIX_COUNT = 5;
const FLOOR_FRAMES = 256;
const CEILING_FRAMES = Number(process.env.DEBLEED_CEILING_FRAMES) || 4096;
const MAX_CARRY_FRAMES = 32;
const STREAM_COPY_FRAMES = 44100;

const MEF_TEMPORAL_SMOOTHING = 0.5;
const WARMUP_SECONDS = 30;
const MWF_EPSILON = 1e-10;
const ARTIFACT_THRESHOLD_SCALE = 0.15;

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

async function readSequentialPadded(
	chunkBuffer: BlockBuffer,
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

export class DeBleedStream extends BufferedTransformStream<DeBleedNode> {
	override blockSize = WHOLE_FILE;

	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	private dfttFftBackend?: FftBackend;
	private dfttFftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	private referenceBuffers: Array<BlockBuffer> = [];
	private chunkFrames!: number;
	private numBins!: number;
	private nlmPool?: NlmWorkerPool;

	override async _setup(context: StreamSetupContext): Promise<void> {
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

		const openedBuffers: Array<BlockBuffer> = [];

		try {
			for (const refPath of this.properties.references) {
				const { buffer: refBuffer } = await readToBuffer(refPath);

				openedBuffers.push(refBuffer);
			}

			this.referenceBuffers = openedBuffers;

			const { fftSize } = this.properties;

			this.numBins = fftSize / 2 + 1;
			this.chunkFrames = computeChunkFrames(this.numBins);
		} catch (error) {
			for (const refBuffer of openedBuffers) {
				await refBuffer.close();
			}

			this.referenceBuffers = [];

			throw error;
		}

		this.nlmPool = createNlmWorkerPool();

		this.log("nlm smoothing pool", { mode: this.nlmPool.mode });
	}

	override async _destroy(): Promise<void> {
		for (const buffer of this.referenceBuffers) {
			await buffer.close();
		}

		this.referenceBuffers = [];

		if (this.nlmPool) {
			await this.nlmPool.close();
			this.nlmPool = undefined;
		}
	}

	private async warmupSeedsAllChannels(
		buffer: BlockBuffer,
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

		for (let refIndex = 0; refIndex < refCount; refIndex++) {
			await referenceBuffers[refIndex]!.reset();
			await readSequentialPadded(referenceBuffers[refIndex]!, 0, warmupFrames, refPaddeds[refIndex]!, hopSize, fftSize, 0);
		}

		const targetStftOutputs = Array.from({ length: channels }, () => allocateStftOutput(warmupFrames, numBins));
		const refStftOutputs = Array.from({ length: refCount }, () => allocateStftOutput(warmupFrames, numBins));

		const targetStfts = targetPaddeds.map((padded, ch) => stft(padded, fftSize, hopSize, targetStftOutputs[ch], this.fftBackend, this.fftAddonOptions));
		const refStfts = refPaddeds.map((padded, refIndex) => stft(padded, fftSize, hopSize, refStftOutputs[refIndex], this.fftBackend, this.fftAddonOptions));

		const maxRefPows = refStfts.map((refStft) => findMaxRefPower(refStft.real, refStft.imag, refStft.frames, numBins));
		const weightEpsilons = maxRefPows.map((maxPow) => 1e-10 * (maxPow + 1e-20));

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

					this.log("warm-up seed degenerate; falling back to cold-start Ĥ(ℓ=0) = 0", { reason: validation.reason }, "warn");

					return coldStartSeed(numBins);
				}

				return seed;
			});

			seedsByChannel.push(validated);
		}

		return seedsByChannel;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const { frames: totalFrames, channels, sampleRate, bitDepth } = buffered;
		const { fftSize, hopSize, reductionStrength, artifactSmoothing, adaptationSpeed } = this.properties;
		const { chunkFrames, numBins, referenceBuffers, nlmPool } = this;
		const refCount = referenceBuffers.length;

		if (totalFrames === 0 || channels === 0) return;

		if (!nlmPool) throw new Error("de-bleed: NLM worker pool not initialized in _setup.");

		const profileEnabled = process.env.DEBLEED_PROFILE === "1";
		const profileMs = { warmup: 0, stftRead: 0, msad: 0, kalman: 0, mwf: 0, nlm: 0, dftt: 0, applyMaskIstft: 0, write: 0 };
		const dfttProfileMs = profileEnabled ? { fill: 0, forward: 0, gain: 0, inverse: 0, ola: 0, normalize: 0 } : undefined;
		const _profStart = (): number => profileEnabled ? performance.now() : 0;
		const _profAdd = (key: keyof typeof profileMs, t0: number): void => {
			if (profileEnabled) profileMs[key] += performance.now() - t0;
		};

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

		const { edgePadSamples, processStftFrames, warmupFrames } = computeProcessGeometry({ totalFrames, fftSize, hopSize, sampleRate, warmupSeconds: WARMUP_SECONDS });

		const _twarm = _profStart();
		const seedsByChannel = await this.warmupSeedsAllChannels(buffered, channels, warmupFrames, fftSize, hopSize);

		_profAdd("warmup", _twarm);

		this.log("warm-up seed complete", { warmupSeconds: WARMUP_SECONDS });

		await buffered.reset();
		for (const refBuffer of referenceBuffers) await refBuffer.reset();

		const kalmanStatesByCh: Array<Array<KalmanState>> = seedsByChannel.map((seeds) => seeds.map((seed) => createKalmanState(numBins, seed)));
		const interfererPsdByCh: Array<InterfererPsdState> = Array.from({ length: channels }, () => createInterfererPsdState(numBins));
		const msadChannelStatesByCh: Array<Array<MsadChannelState>> = Array.from({ length: channels }, () => Array.from({ length: refCount + 1 }, () => createMsadChannelState(numBins)));
		const ispStatesByCh: Array<Array<IspState>> = Array.from({ length: channels }, () => Array.from({ length: refCount }, () => createIspState(numBins)));

		const ispThresholdFrames = sampleRate ? Math.max(1, Math.round(0.5 * sampleRate / hopSize)) : ISP_THRESHOLD_FRAMES;

		const windowFrames = chunkFrames + 2 * carry;
		const windowSamples = windowFrames * hopSize + (fftSize - hopSize);

		const targetStftOutputs: Array<StftOutput> = Array.from({ length: channels }, () => allocateStftOutput(windowFrames, numBins));
		const refStftOutputs: Array<StftOutput> = Array.from({ length: refCount }, () => allocateStftOutput(windowFrames, numBins));
		const rawMask = new Float32Array(new SharedArrayBuffer(windowFrames * numBins * 4));
		const nlmMask = new Float32Array(new SharedArrayBuffer(windowFrames * numBins * 4));
		const finalMask = new Float32Array(windowFrames * numBins);

		const targetReader = new WindowReader(channels, windowSamples);
		const refReaders: Array<WindowReader> = referenceBuffers.map(() => new WindowReader(1, windowSamples));

		await targetReader.preload(buffered, edgePadSamples);
		for (let refIndex = 0; refIndex < refCount; refIndex++) {
			await refReaders[refIndex]!.preload(referenceBuffers[refIndex]!, edgePadSamples);
		}

		const refFrameReals = new Array<Float32Array>(refCount);
		const refFrameImags = new Array<Float32Array>(refCount);
		const bleedTotalReal = new Float32Array(numBins);
		const bleedTotalImag = new Float32Array(numBins);

		const msadFrameReals = new Array<Float32Array>(refCount + 1);
		const msadFrameImags = new Array<Float32Array>(refCount + 1);

		const outputBuffer = new BlockBuffer();

		const progressGate = createProgressGate(processStftFrames);

		try {
			let prevWinStart = 0;

			for (let outStart = 0; outStart < processStftFrames; outStart += chunkFrames) {
				const { outFramesThisChunk, winStart, winFrames, winSamples } = computeChunkWindow({ outStart, chunkFrames, processStftFrames, carry, fftSize, hopSize });

				if (outStart !== 0) {
					const stepFrames = winStart - prevWinStart;
					const stepSamples = stepFrames * hopSize;

					if (stepSamples > 0) {
						const _tadvance = _profStart();

						await targetReader.advance(buffered, stepSamples);
						for (let refIndex = 0; refIndex < refCount; refIndex++) {
							await refReaders[refIndex]!.advance(referenceBuffers[refIndex]!, stepSamples);
						}

						_profAdd("stftRead", _tadvance);
					}
				}

				prevWinStart = winStart;

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

				const cleanedByChannel: Array<Float32Array> = [];

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

						msadFrameReals[0] = frameReal;
						msadFrameImags[0] = frameImag;

						for (let refIndex = 0; refIndex < refCount; refIndex++) {
							msadFrameReals[refIndex + 1] = refFrameReals[refIndex]!;
							msadFrameImags[refIndex + 1] = refFrameImags[refIndex]!;
						}

						const _tmsad = _profStart();
						const msadDecision = computeMsadDecision(msadFrameReals, msadFrameImags, msadChannelStates);

						_profAdd("msad", _tmsad);

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

					const rawView = rawMask.subarray(0, winFrames * numBins);
					const nlmView = nlmMask.subarray(0, winFrames * numBins);
					const finalView = finalMask.subarray(0, winFrames * numBins);

					const _tnlm = _profStart();

					await nlmPool.run(rawView, nlmView, winFrames, numBins, {
						patchSize: 8,
						searchFreqRadius: 8,
						searchTimePre: 16,
						searchTimePost: 4,
						pasteBlockSize: Number(process.env.DEBLEED_NLM_PASTE) || 8,
						threshold,
					});
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
						dfttProfileMs,
					);
					_profAdd("dftt", _tdftt);

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

				const cleanedLength = cleanedByChannel[0]!.length;
				const clip = computeWriteClip({ outStart, winStart, outFramesThisChunk, processStftFrames, hopSize, edgePadSamples, totalFrames, cleanedLength });

				if (!clip) continue;

				const { clipStart, sliceFromOffset, sliceLength } = clip;
				const writeSamplesByChannel: Array<Float32Array> = [];

				for (let ch = 0; ch < channels; ch++) {
					writeSamplesByChannel.push(cleanedByChannel[ch]!.subarray(sliceFromOffset, sliceFromOffset + sliceLength));
				}

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

				const doneFrames = Math.min(outStart + chunkFrames, processStftFrames);

				if (progressGate(doneFrames, Date.now())) this.emitProgress("process", doneFrames, processStftFrames);
			}

			// Defensive trailing zero-pad against off-by-one in the final chunk's clip math.
			if (outputBuffer.frames < totalFrames) {
				const padFrames = totalFrames - outputBuffer.frames;
				const zeroSamples: Array<Float32Array> = [];

				for (let ch = 0; ch < channels; ch++) zeroSamples.push(new Float32Array(padFrames));

				await outputBuffer.write(zeroSamples, sampleRate, bitDepth);
			}

			await outputBuffer.reset();

			yield* outputBuffer.iterate(STREAM_COPY_FRAMES);
		} finally {
			await outputBuffer.close();
		}

		if (profileEnabled) {
			const total = profileMs.warmup + profileMs.stftRead + profileMs.msad + profileMs.kalman + profileMs.mwf + profileMs.nlm + profileMs.dftt + profileMs.applyMaskIstft + profileMs.write;
			const pct = (key: keyof typeof profileMs): string => `${(profileMs[key] / 1000).toFixed(2)}s (${((profileMs[key] / total) * 100).toFixed(1)}%)`;

			this.log("profile", {
				warmup: pct("warmup"),
				stftRead: pct("stftRead"),
				msad: pct("msad"),
				kalman: pct("kalman"),
				mwf: pct("mwf"),
				nlm: pct("nlm"),
				dftt: pct("dftt"),
				applyMaskIstft: pct("applyMaskIstft"),
				write: pct("write"),
				totalS: (total / 1000).toFixed(2),
			});

			if (dfttProfileMs) {
				const dfttSub = (key: keyof typeof dfttProfileMs): string => `${(dfttProfileMs[key] / 1000).toFixed(2)}s`;

				this.log("profile dftt", {
					fill: dfttSub("fill"),
					forward: dfttSub("forward"),
					gain: dfttSub("gain"),
					inverse: dfttSub("inverse"),
					ola: dfttSub("ola"),
					normalize: dfttSub("normalize"),
				});
			}
		}
	}
}

export class DeBleedNode extends TransformNode<DeBleedProperties> {
	static override readonly nodeName = "De-Bleed Adaptive";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Adaptive (MEF FDAF Kalman + MWF + MSAD) reference-based microphone bleed reduction. Stages 1+2 are MEF Meyer-Elshamy-Fingscheidt 2020; Stage 3 is Lukin-Todd 2D NLM+DFTT post-filter.";
	static override readonly schema = schema;
	static override readonly Stream = DeBleedStream;
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

	return new DeBleedNode({ ...options, references: referencesArray });
}
