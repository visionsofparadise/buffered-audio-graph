import { BlockSumAccumulator } from "./block-sum";
import { KWeightedSquaredSum } from "./k-weighted-squared-sum";

const LUFS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -10;
const BLOCK_DURATION_SECONDS = 0.4;
const BLOCK_STEP_SECONDS = 0.1;
const SHORT_TERM_BLOCK_DURATION_SECONDS = 3;
const POWER_FLOOR = 1e-10;
const LRA_ABSOLUTE_GATE_LUFS = -70;
const LRA_RELATIVE_GATE_OFFSET_LU = -20;
const LRA_LOW_PERCENTILE = 0.1;
const LRA_HIGH_PERCENTILE = 0.95;

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

// Mirrors the prior `loudness-stats/utils/measurement.ts:computeLra` exactly (percentile index forms, `<2`-survivor short-circuits) for numerical parity.
function computeLraFromShortTerm(shortTermLoudness: ReadonlyArray<number>): number {
	const absoluteGated: Array<number> = [];

	for (let index = 0; index < shortTermLoudness.length; index++) {
		const value = shortTermLoudness[index] ?? 0;

		if (value > LRA_ABSOLUTE_GATE_LUFS) {
			absoluteGated.push(value);
		}
	}

	if (absoluteGated.length < 2) return 0;

	let absoluteSum = 0;

	for (let index = 0; index < absoluteGated.length; index++) {
		absoluteSum += Math.pow(10, (absoluteGated[index] ?? 0) / 10);
	}

	const absoluteMean = absoluteSum / absoluteGated.length;
	const relativeThreshold = 10 * Math.log10(absoluteMean) + LRA_RELATIVE_GATE_OFFSET_LU;

	const relativeGated: Array<number> = [];

	for (let index = 0; index < absoluteGated.length; index++) {
		const value = absoluteGated[index] ?? 0;

		if (value > relativeThreshold) {
			relativeGated.push(value);
		}
	}

	if (relativeGated.length < 2) return 0;

	relativeGated.sort((lhs, rhs) => lhs - rhs);

	const lowIndex = Math.floor(relativeGated.length * LRA_LOW_PERCENTILE);
	const highIndex = Math.min(Math.ceil(relativeGated.length * LRA_HIGH_PERCENTILE) - 1, relativeGated.length - 1);

	return (relativeGated[highIndex] ?? 0) - (relativeGated[lowIndex] ?? 0);
}

export interface LraConsideredStats {
	readonly min: number;
	readonly median: number;
}

export function getLraConsideredStats(shortTerm: ReadonlyArray<number>): LraConsideredStats {
	const aboveAbsolute: Array<number> = [];

	for (let index = 0; index < shortTerm.length; index++) {
		const lufs = shortTerm[index] ?? 0;

		if (lufs > LRA_ABSOLUTE_GATE_LUFS) {
			aboveAbsolute.push(lufs);
		}
	}

	if (aboveAbsolute.length === 0) {
		return { min: Number.POSITIVE_INFINITY, median: Number.POSITIVE_INFINITY };
	}

	let absoluteSum = 0;

	for (let index = 0; index < aboveAbsolute.length; index++) {
		absoluteSum += Math.pow(10, (aboveAbsolute[index] ?? 0) / 10);
	}

	const absoluteMean = absoluteSum / aboveAbsolute.length;
	const relativeThreshold = 10 * Math.log10(absoluteMean) + LRA_RELATIVE_GATE_OFFSET_LU;

	const considered: Array<number> = [];

	for (let index = 0; index < aboveAbsolute.length; index++) {
		const lufs = aboveAbsolute[index] ?? 0;

		if (lufs > relativeThreshold) {
			considered.push(lufs);
		}
	}

	if (considered.length === 0) {
		return { min: Number.POSITIVE_INFINITY, median: Number.POSITIVE_INFINITY };
	}

	considered.sort((left, right) => left - right);

	const min = considered[0] ?? Number.POSITIVE_INFINITY;
	const middleIndex = considered.length >> 1;
	const median = considered.length % 2 === 1
		? considered[middleIndex] ?? Number.POSITIVE_INFINITY
		: ((considered[middleIndex - 1] ?? 0) + (considered[middleIndex] ?? 0)) / 2;

	return { min, median };
}

// Back-compat wrapper returning only `min(considered)`; prefer `getLraConsideredStats` for new call sites.
export function getLraConsideredMinLufs(shortTerm: ReadonlyArray<number>): number {
	return getLraConsideredStats(shortTerm).min;
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

	private readonly kw: KWeightedSquaredSum;
	private readonly blocks400: BlockSumAccumulator;
	private readonly blocks3s: BlockSumAccumulator;

	private outputBuffer: Float64Array = new Float64Array(0);

	private finalized = false;
	private cachedResult: LoudnessAccumulatorResult | undefined;

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

		const blockStep = Math.round(BLOCK_STEP_SECONDS * sampleRate);

		this.kw = new KWeightedSquaredSum(sampleRate, channelCount, channelWeights);
		this.blocks400 = new BlockSumAccumulator(this.blockSize400, blockStep);
		this.blocks3s = new BlockSumAccumulator(this.blockSize3s, blockStep);
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
	}

	finalize(): LoudnessAccumulatorResult {
		if (this.cachedResult !== undefined) return this.cachedResult;

		this.finalized = true;

		const closed400 = this.blocks400.finalize();
		const closed3s = this.blocks3s.finalize();

		const blockSize400 = this.blockSize400;
		const blockSize3s = this.blockSize3s;

		const momentary: Array<number> = new Array<number>(closed400.length);

		for (let index = 0; index < closed400.length; index++) {
			const sum = closed400[index] ?? 0;

			momentary[index] = LUFS_OFFSET + 10 * Math.log10(Math.max(sum / blockSize400, POWER_FLOOR));
		}

		const shortTerm: Array<number> = new Array<number>(closed3s.length);

		for (let index = 0; index < closed3s.length; index++) {
			const sum = closed3s[index] ?? 0;

			shortTerm[index] = LUFS_OFFSET + 10 * Math.log10(Math.max(sum / blockSize3s, POWER_FLOOR));
		}

		const integrated = applyBs1770Gating(closed400, blockSize400);
		const range = computeLraFromShortTerm(shortTerm);

		this.cachedResult = { integrated, momentary, shortTerm, range };

		return this.cachedResult;
	}
}
