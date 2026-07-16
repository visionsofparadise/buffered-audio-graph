import { BlockSumAccumulator } from "./block-sum";
import { KWeightedSquaredSum } from "./k-weighted-squared-sum";
import { computeLoudnessRange } from "./loudness-range";

// K-weighting, 400 ms blocks, and integrated gating follow ITU-R BS.1770-5.

const LUFS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -10;
const BLOCK_DURATION_SECONDS = 0.4;
const BLOCK_STEP_SECONDS = 0.1;
const SHORT_TERM_BLOCK_DURATION_SECONDS = 3;
const FILE_LRA_TAIL_SECONDS = 1.5;
const FILE_LRA_TAIL_CHUNK_FRAMES = 8192;
const POWER_FLOOR = 1e-10;

function applyBs1770Gating(closedBlockSums: ReadonlyArray<number>, blockSize: number): number {
	const blockCount = closedBlockSums.length;

	if (blockCount === 0) return -Infinity;

	const absoluteThresholdPower = Math.pow(10, (ABSOLUTE_GATE_LUFS - LUFS_OFFSET) / 10);
	let absoluteSurvivorCount = 0;
	let absoluteSum = 0;

	for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
		const power = (closedBlockSums[blockIndex] ?? 0) / blockSize;

		if (power > absoluteThresholdPower) {
			absoluteSum += power;
			absoluteSurvivorCount++;
		}
	}

	if (absoluteSurvivorCount === 0) return -Infinity;

	const absoluteMean = absoluteSum / absoluteSurvivorCount;
	const relativeThresholdLufs = LUFS_OFFSET + 10 * Math.log10(absoluteMean) + RELATIVE_GATE_OFFSET_LU;
	const relativeThresholdPower = Math.pow(10, (relativeThresholdLufs - LUFS_OFFSET) / 10);

	let relativeSurvivorCount = 0;
	let relativeSum = 0;

	for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
		const power = (closedBlockSums[blockIndex] ?? 0) / blockSize;

		if (power > absoluteThresholdPower && power > relativeThresholdPower) {
			relativeSum += power;
			relativeSurvivorCount++;
		}
	}

	if (relativeSurvivorCount === 0) return -Infinity;

	const integratedMean = relativeSum / relativeSurvivorCount;

	return LUFS_OFFSET + 10 * Math.log10(integratedMean);
}

export class IntegratedLufsAccumulator {
	private readonly blockSize: number;

	private readonly kw: KWeightedSquaredSum;
	private readonly blocks: BlockSumAccumulator;

	private outputBuffer: Float64Array = new Float64Array(0);

	private finalized = false;

	constructor(sampleRate: number, channelCount: number, channelWeights?: ReadonlyArray<number>) {
		// Validation lives in KWeightedSquaredSum; re-throw with this class's prefix so callers/tests matching on it still see it.
		if (channelCount <= 0) {
			throw new Error(`IntegratedLufsAccumulator: channelCount must be positive, got ${channelCount}`);
		}

		if (channelWeights !== undefined && channelWeights.length !== channelCount) {
			throw new Error(`IntegratedLufsAccumulator: channelWeights length ${channelWeights.length} does not match channel count ${channelCount}`);
		}

		this.blockSize = Math.round(BLOCK_DURATION_SECONDS * sampleRate);

		const blockStep = Math.round(BLOCK_STEP_SECONDS * sampleRate);

		this.kw = new KWeightedSquaredSum(sampleRate, channelCount, channelWeights);
		this.blocks = new BlockSumAccumulator(this.blockSize, blockStep);
	}

	// `channels[c]` needs >= `frames` valid samples from index 0 (oversized OK); state advances as if appended to one contiguous buffer.
	push(channels: ReadonlyArray<Float32Array>, frames: number): void {
		if (this.finalized) {
			throw new Error("IntegratedLufsAccumulator: push() called after finalize()");
		}

		if (frames <= 0) return;

		if (this.outputBuffer.length < frames) {
			this.outputBuffer = new Float64Array(frames);
		}

		this.kw.push(channels, frames, this.outputBuffer);
		this.blocks.push(this.outputBuffer, frames);
	}

	finalize(): number {
		this.finalized = true;

		return applyBs1770Gating(this.blocks.finalize(), this.blockSize);
	}
}

export interface LoudnessAccumulatorResult {
	integrated: number;
	momentary: Array<number>;
	shortTerm: Array<number>;
	range: number;
}

export class LoudnessAccumulator {
	private readonly blockSize400: number;
	private readonly blockSize3s: number;
	private readonly blockStep: number;
	private readonly sampleRate: number;
	private readonly channelCount: number;

	private readonly kw: KWeightedSquaredSum;
	private readonly blocks400: BlockSumAccumulator;
	private readonly blocks3s: BlockSumAccumulator;

	private outputBuffer: Float64Array = new Float64Array(0);

	private finalized = false;
	private cachedResult: LoudnessAccumulatorResult | undefined;
	private sourceFrames = 0;

	constructor(sampleRate: number, channelCount: number, channelWeights?: ReadonlyArray<number>) {
		// Validate at the wrapper (mirroring IntegratedLufsAccumulator) so callers see consistent error prefixes.
		if (channelCount <= 0) {
			throw new Error(`LoudnessAccumulator: channelCount must be positive, got ${channelCount}`);
		}

		if (channelWeights !== undefined && channelWeights.length !== channelCount) {
			throw new Error(`LoudnessAccumulator: channelWeights length ${channelWeights.length} does not match channel count ${channelCount}`);
		}

		this.blockSize400 = Math.round(BLOCK_DURATION_SECONDS * sampleRate);
		this.blockSize3s = Math.round(SHORT_TERM_BLOCK_DURATION_SECONDS * sampleRate);
		this.blockStep = Math.round(BLOCK_STEP_SECONDS * sampleRate);
		this.sampleRate = sampleRate;
		this.channelCount = channelCount;

		this.kw = new KWeightedSquaredSum(sampleRate, channelCount, channelWeights);
		this.blocks400 = new BlockSumAccumulator(this.blockSize400, this.blockStep);
		this.blocks3s = new BlockSumAccumulator(this.blockSize3s, this.blockStep);
	}

	push(channels: ReadonlyArray<Float32Array>, frames: number): void {
		if (this.finalized) {
			throw new Error("LoudnessAccumulator: push() called after finalize()");
		}

		if (frames <= 0) return;

		if (this.outputBuffer.length < frames) {
			this.outputBuffer = new Float64Array(frames);
		}

		this.kw.push(channels, frames, this.outputBuffer);
		this.blocks400.push(this.outputBuffer, frames);
		this.blocks3s.push(this.outputBuffer, frames);
		this.sourceFrames += frames;
	}

	finalize(): LoudnessAccumulatorResult {
		if (this.cachedResult !== undefined) return this.cachedResult;

		this.finalized = true;

		const sourceShortTermCount = this.sourceFrames < this.blockSize3s ? 0 : Math.floor((this.sourceFrames - this.blockSize3s) / this.blockStep) + 1;
		const tailFrames = Math.round(FILE_LRA_TAIL_SECONDS * this.sampleRate);
		const tailChunkFrames = Math.min(FILE_LRA_TAIL_CHUNK_FRAMES, tailFrames);
		const zeroChannels = Array.from({ length: this.channelCount }, () => new Float32Array(tailChunkFrames));
		let remainingTailFrames = tailFrames;

		while (remainingTailFrames > 0) {
			const frames = Math.min(remainingTailFrames, tailChunkFrames);

			if (this.outputBuffer.length < frames) this.outputBuffer = new Float64Array(frames);

			this.kw.push(zeroChannels, frames, this.outputBuffer);
			this.blocks3s.push(this.outputBuffer, frames);
			remainingTailFrames -= frames;
		}

		const closed400 = this.blocks400.finalize();
		const closed3s = this.blocks3s.finalize();

		const blockSize400 = this.blockSize400;
		const blockSize3s = this.blockSize3s;

		const momentary: Array<number> = new Array<number>(closed400.length);

		for (let index = 0; index < closed400.length; index++) {
			const sum = closed400[index] ?? 0;

			momentary[index] = LUFS_OFFSET + 10 * Math.log10(Math.max(sum / blockSize400, POWER_FLOOR));
		}

		const fileShortTerm: Array<number> = new Array<number>(closed3s.length);

		for (let index = 0; index < closed3s.length; index++) {
			const sum = closed3s[index] ?? 0;

			fileShortTerm[index] = LUFS_OFFSET + 10 * Math.log10(Math.max(sum / blockSize3s, POWER_FLOOR));
		}

		const shortTerm = fileShortTerm.slice(0, sourceShortTermCount);
		const integrated = applyBs1770Gating(closed400, blockSize400);
		const range = computeLoudnessRange(fileShortTerm);

		this.cachedResult = { integrated, momentary, shortTerm, range };

		return this.cachedResult;
	}
}
