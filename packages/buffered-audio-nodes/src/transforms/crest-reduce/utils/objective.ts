import { TruePeakAccumulator, linearToDb } from "@e9g/buffered-audio-nodes-utils";

/**
 * Per-frame 4× true-peak measure for the crestReduce TP-driven binding
 * gate (the 2026-05-17 keystone): it is the gate's per-window proximity
 * LHS — the window's own per-channel 4× true peak compared against the
 * global 4× true peak (`binding.ts` `isBindingPeak` / `classifyWindow`;
 * `windowed.ts` `streamLatticeTrajectory`). It is NOT a whole-signal
 * never-worsen comparison (that veto was removed by the keystone — the
 * only never-worsen is the per-window commit-only-if-better inside the
 * deterministic Item-7 minimiser).
 *
 * Given one frame's per-channel sample arrays, returns the BS.1770-4
 * Annex 1 true peak (4× polyphase oversampled) of that frame alone, in
 * dBTP.
 *
 * A FRESH {@link TruePeakAccumulator} is constructed on every call and
 * discarded. This is mandatory, for two independent reasons:
 *   1. The accumulator's per-channel polyphase upsamplers carry a
 *      12-tap input history across `push` calls (true-peak.ts: "the
 *      per-channel upsampler's 12-tap history carries across push
 *      calls so chunk boundaries are invisible"). Reusing one
 *      accumulator across candidate frames would let one candidate's
 *      tail samples lift the next candidate's measured peak —
 *      contaminating the never-worsen comparison.
 *   2. `finalize()` returns a running max that only ever grows; a
 *      reused accumulator could never report a *lower* peak for a
 *      better candidate.
 * Fresh-per-call eliminates both. The accumulator is cheap to
 * construct (a small fixed-tap FIR state per channel).
 *
 * Returns `linearToDb(0) = -200 dB`-floored value for a silent frame
 * (`linearToDb` clamps at `1e-10`), and the same floor for an empty
 * frame (no samples pushed → `finalize()` returns 0).
 */
export function measureFrameTruePeakDb(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const channelCount = channels.length;

	if (channelCount === 0) return linearToDb(0);

	const frames = channels[0]?.length ?? 0;
	const accumulator = new TruePeakAccumulator(sampleRate, channelCount, 4);

	accumulator.push(channels, frames);

	return linearToDb(accumulator.finalize());
}

