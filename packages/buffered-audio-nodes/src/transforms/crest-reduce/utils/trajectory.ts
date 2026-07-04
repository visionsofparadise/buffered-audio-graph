import { BidirectionalIir } from "@buffered-audio/utils";
import { GROUP_DELAY_CEILING_MS } from "./search";

// pre-smoothing: decorrelation-amount envelope; post-smoothing: reconstructed rows.
export interface ControlTrajectory {
	readonly rows: ReadonlyArray<Float32Array>;
	readonly baseRows?: ReadonlyArray<Float32Array>;
	readonly amountEnv?: Float32Array;
	readonly laneCount: number;
	readonly identity: Float32Array;
	readonly transientMask: Float32Array;
	readonly peakSampleIndex?: Int32Array;
}

// pull scalar toward 0 at onsets before the spill IIR (QA-tuned 0.5); feeds spill only, not the exact hold.
export const TRANSIENT_PULLBACK = 0.5;

export function trajectoryFrameRate(sampleRate: number, hopSize: number): number {
	if (!(sampleRate > 0) || !(hopSize > 0)) return 1;

	const rate = sampleRate / hopSize;

	return rate > 0 && Number.isFinite(rate) ? rate : 1;
}

// Wexact = group-delay span in frames (settling lead-in + causal smear); never a function of smoothing.
export function exactHoldHalfWidthFrames(sampleRate: number, hopSize: number): number {
	if (!(sampleRate > 0) || !(hopSize > 0)) return 1;

	const ceilingSamples = (GROUP_DELAY_CEILING_MS / 1000) * sampleRate;

	return Math.max(1, Math.ceil(ceilingSamples / hopSize) + 1);
}

export function smoothControlTrajectory(
	trajectory: ControlTrajectory,
	smoothingMs: number,
	frameRate: number,
	exactHoldFrames: number,
	hopSize: number,
): ControlTrajectory {
	// CONTRACT: only ever called on a streamLatticeTrajectory result, which always populates
	// baseRows/amountEnv/peakSampleIndex (OPTIONAL only for the byte-frozen path); a missing field here is a wiring bug.
	const baseRows = trajectory.baseRows ?? [];
	const amountEnv = trajectory.amountEnv ?? new Float32Array(0);
	const peakSampleIndex = trajectory.peakSampleIndex ?? new Int32Array(0);
	const frameCount = baseRows.length;
	const laneCount = trajectory.laneCount;

	if (frameCount === 0 || laneCount === 0) {
		return {
			rows: [],
			baseRows,
			amountEnv,
			laneCount,
			identity: trajectory.identity,
			transientMask: trajectory.transientMask,
			peakSampleIndex,
		};
	}

	const transientMask = trajectory.transientMask;
	const identity = trajectory.identity;
	const halfWidth = Math.max(1, Math.floor(exactHoldFrames));
	const hop = hopSize > 0 ? hopSize : 1;

	const exactHeld = new Float32Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const amount = amountEnv[frame] ?? 0;

		if (amount <= 0) continue;

		const peakSample = peakSampleIndex[frame] ?? frame * hop;
		const center = Math.round(peakSample / hop);
		const lo = Math.max(0, center - halfWidth);
		const hi = Math.min(frameCount - 1, center + halfWidth);

		for (let held = lo; held <= hi; held++) {
			if (amount > (exactHeld[held] ?? 0)) exactHeld[held] = amount;
		}
	}

	const pulled = new Float32Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const value = amountEnv[frame] ?? 0;
		const isTransient = (transientMask[frame] ?? 0) > 0;

		pulled[frame] = isTransient ? value + TRANSIENT_PULLBACK * (0 - value) : value;
	}

	const iir = new BidirectionalIir({ smoothingMs, sampleRate: frameRate });
	const iirSpill = iir.applyBidirectional(pulled);

	const finalAmount = new Float32Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		finalAmount[frame] = Math.max(exactHeld[frame] ?? 0, iirSpill[frame] ?? 0);
	}

	const rows: Array<Float32Array> = new Array<Float32Array>(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const base = baseRows[frame] ?? identity;
		const amount = finalAmount[frame] ?? 0;
		const row = new Float32Array(laneCount);

		for (let lane = 0; lane < laneCount; lane++) row[lane] = amount * (base[lane] ?? 0);

		rows[frame] = row;
	}

	return { rows, baseRows, amountEnv, laneCount, identity, transientMask, peakSampleIndex };
}
