import type { BlockBuffer } from "@buffered-audio/core";
import { TruePeakUpsampler, linearToDb, stft, type FftBackend } from "@buffered-audio/utils";
import { isBindingPeak } from "./binding";
import { designDispersionAllpass, schroederTargetToDelay } from "./dispersion";
import { LATTICE_ORDER, peakPriorityAmount, stepDownToReflection } from "./lattice";
import { measureFrameTruePeakDb } from "./objective";
import { searchBindingPeak } from "./search";
import type { ControlTrajectory } from "./trajectory";

const WALK_CHUNK_FRAMES = 1 << 16;

// Mirrors lattice.ts TRANSIENT_ENERGY_RATIO (module-private there); both
// sides must compute the same per-frame transient flag.
const TRANSIENT_ENERGY_RATIO = 2.0;

function stftFrameCount(signalLength: number, frameSize: number, hopSize: number): number {
	if (signalLength < frameSize || hopSize <= 0) return 0;

	return Math.floor((signalLength - frameSize) / hopSize) + 1;
}

// Node-local (tracks the argmax the Item-7 gate needs, unlike the shared accumulator). The per-channel
// upsampler's 12-tap history carries across pushes, so the result is bit-identical to a whole-buffer walk.
export class TruePeakArgmaxAccumulator {
	private readonly upsamplers: Array<TruePeakUpsampler>;
	private runningMax = 0;
	private peakInputSample = 0;
	private inputBase = 0;

	constructor(private readonly channelCount: number, _sampleRate: number) {
		this.upsamplers = [];

		for (let channel = 0; channel < channelCount; channel++) this.upsamplers.push(new TruePeakUpsampler(4));
	}

	push(channels: ReadonlyArray<Float32Array>, frames: number): void {
		if (frames <= 0) {
			this.inputBase += frames > 0 ? frames : 0;

			return;
		}

		for (let channel = 0; channel < this.channelCount; channel++) {
			const samples = channels[channel];
			const upsampler = this.upsamplers[channel];

			if (samples === undefined || upsampler === undefined) continue;

			const slice = samples.length === frames ? samples : samples.subarray(0, frames);
			const upsampled = upsampler.upsample(slice);

			for (let index = 0; index < upsampled.length; index++) {
				const value = upsampled[index] ?? 0;
				const magnitude = value < 0 ? -value : value;

				if (magnitude > this.runningMax) {
					this.runningMax = magnitude;
					this.peakInputSample = this.inputBase + Math.floor(index / 4);
				}
			}
		}

		this.inputBase += frames;
	}

	finalize(): { db: number; peakInputSample: number } {
		return { db: linearToDb(this.runningMax), peakInputSample: this.peakInputSample };
	}
}

// Streaming whole-signal 4× true peak; retained for the binding.ts measureWholeSignalTruePeakDb caller.
export async function measureBufferTruePeakDb(buffer: BlockBuffer, sampleRate: number): Promise<number> {
	const channelCount = buffer.channels;
	const totalFrames = buffer.frames;

	if (channelCount === 0 || totalFrames === 0) return linearToDb(0);

	await buffer.reset();

	const accumulator = new TruePeakArgmaxAccumulator(channelCount, sampleRate);

	let toRead = totalFrames;

	while (toRead > 0) {
		const want = Math.min(WALK_CHUNK_FRAMES, toRead);
		const chunk = await buffer.read(want);
		const got = chunk.samples[0]?.length ?? 0;

		if (got === 0) break;

		accumulator.push(chunk.samples, got);
		toRead -= got;
	}

	return accumulator.finalize().db;
}

export interface WindowPeak {
	readonly peakMagnitude: number;
	readonly headroom: number;
}

export interface ItemSevenSearchParams {
	readonly globalTruePeakDb: number;
	readonly peakInputSample: number;
	readonly sampleRate: number;
	readonly lambda: number;
}

export async function streamLatticeTrajectory(
	buffer: BlockBuffer,
	frameSize: number,
	hopSize: number,
	backend?: FftBackend,
	addonOptions?: { vkfftPath?: string; fftwPath?: string },
	search?: ItemSevenSearchParams,
	progress?: (done: number, total: number) => void,
): Promise<{ trajectory: ControlTrajectory; frameCount: number; signalLength: number; windowPeaks: Array<WindowPeak>; bindingMask: Array<boolean> }> {
	const channelCount = buffer.channels;
	const signalLength = buffer.frames;
	const order = LATTICE_ORDER;
	const halfSize = frameSize / 2 + 1;
	const frameCount = stftFrameCount(signalLength, frameSize, hopSize);
	const identity = new Float32Array(order);

	const baseRows = new Array<Float32Array>(frameCount);
	const amountEnv = new Float32Array(frameCount);
	const transientMask = new Float32Array(frameCount);
	const peakSampleIndex = new Int32Array(frameCount);
	const trajectory: ControlTrajectory = {
		rows: [],
		baseRows,
		amountEnv,
		laneCount: order,
		identity,
		transientMask,
		peakSampleIndex,
	};
	const windowPeaks = new Array<WindowPeak>(frameCount);
	const bindingMask = new Array<boolean>(frameCount).fill(true);

	if (frameCount === 0 || channelCount === 0) return { trajectory, frameCount, signalLength, windowPeaks, bindingMask };

	await buffer.reset();

	const sumRing = new Float32Array(frameSize);
	const channelRings: Array<Float32Array> = Array.from({ length: channelCount }, () => new Float32Array(frameSize));
	const window = new Float32Array(frameSize);
	const channelWindows: Array<Float32Array> = Array.from({ length: channelCount }, () => new Float32Array(frameSize));
	const sumMagnitude = new Float32Array(halfSize);
	let consumed = 0;
	let nextFrame = 0;
	let previousEnergy = 0;

	let toRead = signalLength;

	while (toRead > 0 && nextFrame < frameCount) {
		const want = Math.min(WALK_CHUNK_FRAMES, toRead);
		const chunk = await buffer.read(want);
		const got = chunk.samples[0]?.length ?? 0;

		if (got === 0) break;

		for (let index = 0; index < got; index++) {
			let sample = 0;

			const ringPos = consumed % frameSize;

			for (let ch = 0; ch < channelCount; ch++) {
				const value = chunk.samples[ch]?.[index] ?? 0;

				sample = Math.fround(sample + value);
				const channelRing = channelRings[ch];

				if (channelRing) channelRing[ringPos] = value;
			}

			sumRing[ringPos] = sample;
			consumed += 1;

			while (nextFrame < frameCount && consumed >= nextFrame * hopSize + frameSize) {
				const start = nextFrame * hopSize;

				for (let pos = 0; pos < frameSize; pos++) window[pos] = sumRing[(start + pos) % frameSize] ?? 0;

				for (let ch = 0; ch < channelCount; ch++) {
					const channelRing = channelRings[ch];
					const channelWindow = channelWindows[ch];

					if (!channelRing || !channelWindow) continue;

					for (let pos = 0; pos < frameSize; pos++) channelWindow[pos] = channelRing[(start + pos) % frameSize] ?? 0;
				}

				const frameStft = stft(window, frameSize, frameSize, undefined, backend, addonOptions);
				let energy = 0;

				for (let bin = 0; bin < halfSize; bin++) {
					const re = frameStft.real[bin] ?? 0;
					const im = frameStft.imag[bin] ?? 0;
					const mag = Math.hypot(re, im);

					sumMagnitude[bin] = mag;
					energy += mag * mag;
				}

				transientMask[nextFrame] = previousEnergy > 0 && energy > TRANSIENT_ENERGY_RATIO * previousEnergy ? 1 : 0;
				previousEnergy = energy;

				const amount = peakPriorityAmount(window, 0, frameSize);

				let windowPeak = 0;
				let peakPos = 0;

				for (let pos = 0; pos < frameSize; pos++) {
					const value = window[pos] ?? 0;
					const absolute = value < 0 ? -value : value;

					if (absolute > windowPeak) {
						windowPeak = absolute;
						peakPos = pos;
					}
				}

				windowPeaks[nextFrame] = { peakMagnitude: windowPeak, headroom: amount };
				peakSampleIndex[nextFrame] = start + peakPos;

				const delay = schroederTargetToDelay(sumMagnitude, amount);
				const { denominator } = designDispersionAllpass(delay, order);
				const reflection = stepDownToReflection(denominator);
				const row = new Float32Array(order);

				for (let section = 0; section < order; section++) row[section] = reflection[section] ?? 0;

				baseRows[nextFrame] = row;

				if (search) {
					const frameTruePeakDb = measureFrameTruePeakDb(channelWindows, search.sampleRate);
					const isGlobalTpFrame = Math.round(search.peakInputSample / hopSize) === nextFrame;
					const bound = isBindingPeak(frameTruePeakDb, amount, search.globalTruePeakDb, isGlobalTpFrame);

					bindingMask[nextFrame] = bound;

					if (bound) {
						const result = searchBindingPeak(channelWindows, row, order, search.lambda);

						amountEnv[nextFrame] = result.scale;
					} else {
						amountEnv[nextFrame] = 0;
					}
				} else {
					amountEnv[nextFrame] = 1;
				}

				nextFrame += 1;
			}
		}

		toRead -= got;

		progress?.(nextFrame, frameCount);
	}

	for (let frame = 0; frame < frameCount; frame++) {
		const wasReached = baseRows[frame] !== undefined;

		baseRows[frame] ??= new Float32Array(order);
		if (!wasReached) amountEnv[frame] = 0;
		windowPeaks[frame] ??= { peakMagnitude: 0, headroom: 0 };

		if (search && !wasReached) bindingMask[frame] = false;
	}

	return { trajectory, frameCount, signalLength, windowPeaks, bindingMask };
}

// Emission-time per-chunk applicator; carries per-channel state + the absolute sample index across chunks,
// so the output is bit-identical to a contiguous pass. Recurrence transcribed verbatim from processLatticeChannel.
export class LatticeApplyState {
	// Mirrors lattice.ts MAX_REFLECTION (module-private there); both sides must clamp identically.
	private static readonly MAX_REFLECTION = 0.95;
	private static readonly SCALE = 1;

	private readonly rows: ReadonlyArray<Float32Array>;
	private readonly frameCount: number;
	private readonly state: Array<Float32Array>;
	private sample = 0;

	constructor(
		private readonly trajectory: ControlTrajectory,
		private readonly order: number,
		private readonly hopSize: number,
		channelCount: number,
	) {
		this.rows = trajectory.rows;
		this.frameCount = this.rows.length;
		this.state = Array.from({ length: channelCount }, () => new Float32Array(order));
	}

	apply(channels: ReadonlyArray<Float32Array>, frames: number): Array<Float32Array> {
		const channelCount = this.state.length;
		const order = this.order;
		const hopSize = this.hopSize;
		const frameCount = this.frameCount;
		const rows = this.rows;
		const out: Array<Float32Array> = Array.from({ length: channelCount }, () => new Float32Array(frames));

		for (let index = 0; index < frames; index++) {
			const framePos = hopSize > 0 ? this.sample / hopSize : 0;
			const frame0 = Math.min(frameCount - 1, Math.max(0, Math.floor(framePos)));
			const frame1 = Math.min(frameCount - 1, frame0 + 1);
			const fraction = framePos - frame0;
			const row0 = rows[frame0] ?? this.trajectory.identity;
			const row1 = rows[frame1] ?? this.trajectory.identity;

			for (let ch = 0; ch < channelCount; ch++) {
				const inputValue = channels[ch]?.[index] ?? 0;
				const outChannel = out[ch];
				const chState = this.state[ch] ?? new Float32Array(order);
				let signalValue = inputValue;

				for (let section = 0; section < order; section++) {
					const interpolated = (row0[section] ?? 0) + fraction * ((row1[section] ?? 0) - (row0[section] ?? 0));
					let kCoeff = LatticeApplyState.SCALE * interpolated;

					if (kCoeff > LatticeApplyState.MAX_REFLECTION) kCoeff = LatticeApplyState.MAX_REFLECTION;
					else if (kCoeff < -LatticeApplyState.MAX_REFLECTION) kCoeff = -LatticeApplyState.MAX_REFLECTION;

					const cCoeff = Math.sqrt(Math.max(0, 1 - kCoeff * kCoeff));
					const delayed = chState[section] ?? 0;
					const toDelay = cCoeff * signalValue + kCoeff * delayed;
					const sectionOut = -kCoeff * signalValue + cCoeff * delayed;

					chState[section] = toDelay;
					signalValue = sectionOut;
				}

				if (outChannel) outChannel[index] = signalValue;
			}

			this.sample += 1;
		}

		return out;
	}
}
