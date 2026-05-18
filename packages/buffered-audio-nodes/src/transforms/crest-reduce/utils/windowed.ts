// Node-local streaming consumption for crestReduce (NOT shared DSP —
// node-specific composition glue; the 2026-04-23 design-architecture
// boundary: reusable primitives live in buffered-audio-nodes-utils,
// node-specific composition stays node-local).
//
// Phase 2 (plan-crest-reduce-envelope-v2.md) removes the
// design-streaming.md whole-file-materialization ANTI-PATTERN from
// crestReduce. The as-built `_process` drained the disk-backed
// `ChunkBuffer` into stream-resident full-length per-channel
// `Float32Array`s (`channelSignals`, `sumSignal`) plus a resident output
// array, and the never-worsen loop held up to 11 full-length candidate
// arrays.
//
// SCOPE NOTE (the genuine elimination — recorded in the plan 2.2 Notes):
// the materialization is GENUINELY ELIMINATED, not relocated. There is NO
// whole-signal `Float32Array` anywhere in this module or in `index.ts`.
// Phase 2 still preserves the as-built ALGORITHM within FP (topology +
// schema only), and it does so by STREAMING every stage that the as-built
// expressed over a contiguous array — none of which actually requires the
// whole signal resident:
//
//   * STFT analysis is a SLIDING WINDOW: frame k reads input samples
//     [k·hop, k·hop+frameSize). `streamLatticeTrajectory` walks the
//     disk-backed buffer ONCE, maintains a `frameSize` ring of the
//     linked-stereo sum (computed on the fly per sample — no whole
//     `sumSignal` array), and at each hop emits one trajectory row by
//     running the VERBATIM per-frame math (`stft` on the single
//     `frameSize` window — bit-identical to the batch STFT since each
//     frame's windowed-FFT input is identical and the same `fft`/addon
//     path runs; `peakPriorityAmount` / `schroederTargetToDelay` /
//     `designDispersionAllpass` / `stepDownToReflection` verbatim). Only
//     the O(frames) trajectory + bounded ring/scratch stay resident.
//   * Decorrelation-envelope smoothing (`trajectory.ts`
//     `smoothControlTrajectory` — the bidirectional zero-phase pass,
//     Phase 8 / the 2026-05-17 correction) operates on the small
//     O(frames) trajectory, NEVER the audio — resident is fine. (There
//     is NO whole-signal never-worsen: the ONLY never-worsen is the
//     per-window commit-only-if-better intrinsic to the deterministic
//     Item-7 minimiser — the as-built `scaleTrajectoryTowardIdentity` +
//     global candidate loop are removed and stay removed.)
//   * The lattice apply is a RECURSIVE (IIR) per-sample filter:
//     output[n] depends only on input[n], the frame-interpolated
//     coefficients at sample n, and the carried per-section z⁻¹ state
//     from n−1. `streamLatticeApply` walks the buffer chunk-by-chunk and
//     carries the per-channel section state + the absolute sample index
//     across chunks, so its output is BIT-IDENTICAL to processing one
//     contiguous array (a recursive filter's output depends only on input
//     + carried state, not on how the input is buffered). The per-sample
//     recurrence is transcribed VERBATIM from `processLatticeChannel`
//     (lattice.ts) — same arithmetic, same `MAX_REFLECTION` clamp, same
//     interpolation; only the buffering (a streaming driver vs an
//     internal whole-`output` allocation) differs, which a recursive
//     filter is invariant to.
//   * Production is a SINGLE streaming pass (`streamLatticeApply`) over
//     the committed per-peak-exact + bidirectionally-smoothed envelope,
//     writing straight into the node-owned output `ChunkBuffer` — no
//     whole-signal candidate-measurement pass exists (the 2026-05-17
//     keystone removed the whole-signal never-worsen veto; the only
//     never-worsen is the per-window commit-only-if-better inside the
//     deterministic Item-7 minimiser). No full-length candidate array
//     ever.
//
// The 2026-05-12 ChunkBuffer sequential-only API is honoured throughout:
// `read(n)` / `reset()` only, NO offset access, NO single `read(total)`.
// `bufferSize = WHOLE_FILE` topology is normal and stays.

import type { ChunkBuffer } from "@e9g/buffered-audio-nodes-core";
import { TruePeakUpsampler, linearToDb, stft, type FftBackend } from "@e9g/buffered-audio-nodes-utils";
import { isBindingPeak } from "./binding";
import { designDispersionAllpass, schroederTargetToDelay } from "./dispersion";
import { LATTICE_ORDER, peakPriorityAmount, stepDownToReflection } from "./lattice";
import { measureFrameTruePeakDb } from "./objective";
import { searchBindingPeak } from "./search";
import type { ControlTrajectory } from "./trajectory";

/**
 * Chunk size (frames) for the sequential walks. A bounded fixed slice so a
 * walk never issues a single whole-signal `read(total)` (the
 * design-streaming.md anti-pattern). Not load-bearing for correctness — a
 * recursive filter / sliding-window STFT / true-peak accumulator are all
 * invariant to how the sequential input is sliced; any positive chunk
 * size reconstructs the identical signal/trajectory/measurement.
 */
const WALK_CHUNK_FRAMES = 1 << 16;

/**
 * A transient is flagged at frame `f` when its windowed energy exceeds the
 * previous frame's by more than this ratio. Transcribed VERBATIM from
 * `lattice.ts` `TRANSIENT_ENERGY_RATIO` (a module-private constant there);
 * the streaming trajectory driver replaces the `extractLatticeTrajectory`
 * orchestrator and must reproduce its per-frame transient flag bit-for-bit
 * (carried `previousEnergy` across frames, exactly as the as-built loop).
 */
const TRANSIENT_ENERGY_RATIO = 2.0;

/**
 * Number of analysis frames for a signal of `signalLength` samples at
 * `frameSize`/`hopSize`. EXACTLY the `stft` frame count
 * (`Math.floor((signal.length - fftSize) / hopSize) + 1`, clamped at 0) —
 * the streaming driver must emit precisely the frames the as-built
 * `stft(sumSignal, …)` produced.
 */
function stftFrameCount(signalLength: number, frameSize: number, hopSize: number): number {
	if (signalLength < frameSize || hopSize <= 0) return 0;

	return Math.floor((signalLength - frameSize) / hopSize) + 1;
}

/**
 * Whole-signal 4× true peak (dBTP) **and the input-sample index of the
 * global 4× true peak**, driven from a sequential chunked walk over the
 * disk-backed `ChunkBuffer` (the 2026-05-17 keystone: the TP-driven
 * binding gate force-binds the analysis frame containing the file's
 * global 4× true peak, robust to per-frame cold-history TP undercount).
 *
 * Uses per-channel BS.1770-4 Annex 1 4× {@link TruePeakUpsampler}
 * DIRECTLY (one cold instance per channel for the whole walk — its 12-tap
 * input history carries across `upsample` calls so chunk boundaries are
 * invisible and the running max is FP-identical to a single
 * `TruePeakAccumulator` over the contiguous signal) so the per-sample
 * argmax can be tracked, which `TruePeakAccumulator` does not expose.
 *
 * Argmax attribution (phase-0 impulse-aligned): for input sample `n` the
 * 4 oversampled outputs are at upsampled indices `4n+p`, `p ∈ 0..3`
 * (phase 0 = the input sample itself — `COEFFICIENTS_4X[0]` is the
 * identity tap). The maximum |upsampled| over ALL `n`, all phases, all
 * channels is attributed to its input sample `n` (`peakInputSample`).
 *
 * Streaming — NO whole-signal `Float32Array` (a bounded per-channel
 * upsampled chunk only; `WALK_CHUNK_FRAMES` input → `4·WALK_CHUNK_FRAMES`
 * upsampled, both bounded scratch). `reset()` before the walk so it
 * re-reads from frame 0; the caller handles any subsequent `reset()`.
 *
 * `_sampleRate` is accepted for API symmetry / call-site stability (the
 * `measureBufferTruePeakDb` delegate + the gate's unit tests pass it)
 * but is UNUSED — the BS.1770-4 Annex 1 polyphase FIR is rate-
 * independent (the same convention as `TruePeakAccumulator`'s
 * `_sampleRate`).
 */
export async function measureBufferTruePeakWithArgmax(buffer: ChunkBuffer, _sampleRate: number): Promise<{ db: number; peakInputSample: number }> {
	const channelCount = buffer.channels;
	const totalFrames = buffer.frames;

	if (channelCount === 0 || totalFrames === 0) return { db: linearToDb(0), peakInputSample: 0 };

	await buffer.reset();

	// One cold 4× upsampler per channel for the WHOLE walk (the 12-tap
	// history carries across `upsample` so chunk boundaries are invisible
	// — FP-identical running max to a single `TruePeakAccumulator`).
	const upsamplers: Array<TruePeakUpsampler> = [];

	for (let channel = 0; channel < channelCount; channel++) upsamplers.push(new TruePeakUpsampler(4));

	let runningMax = 0;
	let peakInputSample = 0;
	let inputBase = 0; // absolute input-sample index of this chunk's frame 0
	let toRead = totalFrames;

	while (toRead > 0) {
		const want = Math.min(WALK_CHUNK_FRAMES, toRead);
		const chunk = await buffer.read(want);
		const got = chunk.samples[0]?.length ?? 0;

		if (got === 0) break;

		for (let channel = 0; channel < channelCount; channel++) {
			const samples = chunk.samples[channel];
			const upsampler = upsamplers[channel];

			if (samples === undefined || upsampler === undefined) continue;

			const slice = samples.length === got ? samples : samples.subarray(0, got);
			const upsampled = upsampler.upsample(slice);

			for (let index = 0; index < upsampled.length; index++) {
				const value = upsampled[index] ?? 0;
				const magnitude = value < 0 ? -value : value;

				if (magnitude > runningMax) {
					runningMax = magnitude;
					// Upsampled index `4n+p` ⇒ input sample `n` (phase-0
					// impulse-aligned attribution): n = floor(index / 4).
					peakInputSample = inputBase + Math.floor(index / 4);
				}
			}
		}

		inputBase += got;
		toRead -= got;
	}

	return { db: linearToDb(runningMax), peakInputSample };
}

/**
 * Whole-signal 4× true peak (dBTP) only — the db-projection of
 * {@link measureBufferTruePeakWithArgmax} (kept as a stable
 * `Promise<number>` for `binding.ts`'s `measureWholeSignalTruePeakDb`
 * wrapper and the gate's unit tests; the streaming/no-materialization
 * discipline is identical — same per-channel upsampler walk). `reset()`
 * before the walk; the caller handles any subsequent `reset()` it needs.
 */
export async function measureBufferTruePeakDb(buffer: ChunkBuffer, sampleRate: number): Promise<number> {
	return (await measureBufferTruePeakWithArgmax(buffer, sampleRate)).db;
}

/**
 * Streaming whole-file analysis: walk the disk-backed `ChunkBuffer` ONCE
 * and emit the per-frame reflection-coefficient `ControlTrajectory` (the
 * O(frames) result — the ONLY resident product) WITHOUT ever holding the
 * whole signal. Replaces the `extractLatticeTrajectory` orchestrator with
 * a sliding-window driver that reuses the VERBATIM per-frame kernels:
 *
 *   - the linked-stereo sum is accumulated per sample into a `frameSize`
 *     ring (same iterative `Float32Array` channel-add as the as-built
 *     `sumChannels`, so each window sample is bit-identical to
 *     `sumSignal[start + i]`);
 *   - at each hop boundary the contiguous `frameSize` window is extracted
 *     and passed to the VERBATIM `stft` (a single-frame call — the
 *     windowed-FFT input is bit-identical to the batch `stft`'s frame
 *     `f`, and the same `fft`/addon code path runs, so `real`/`imag` are
 *     FP-identical), then the VERBATIM `peakPriorityAmount` /
 *     `schroederTargetToDelay` / `designDispersionAllpass` /
 *     `stepDownToReflection` produce the row exactly as the as-built
 *     per-frame loop did;
 *   - the per-frame transient flag carries `previousEnergy` across frames
 *     exactly as the as-built loop (the verbatim energy/ratio test).
 *
 * Bounded resident state: the O(frames) trajectory + a `frameSize` sum
 * ring + ONE `frameSize` ring PER CHANNEL (the 2026-05-17 keystone — the
 * TP-driven gate + Item-7 TP objective need each channel's window;
 * BOUNDED at `(channelCount+1)·frameSize`, NOT whole-signal) + per-frame
 * `frameSize`/`halfSize` scratch — NO whole-signal array.
 *
 * **The Item-7 per-binding-peak search wired in (2026-05-17 KEYSTONE
 * rework).** When `search` is supplied, the driver does the binding-
 * window handling INLINE during the single trajectory walk (the
 * per-frame sum + per-channel windows are extracted from the rings at
 * bounded cost). Per frame:
 *   - the Abel & Smith (Item 9) + RMV step-down (Item 8) reflection row
 *     is fitted VERBATIM as before (the search adapts the scalar feeding
 *     this fit; it does NOT replace the fit or the step-down);
 *   - the frame is classified by the TP-DRIVEN gate predicate
 *     `isBindingPeak(frameTruePeakDb, headroom, globalTruePeakDb,
 *     isGlobalTpFrame)` (`binding.ts` UNFROZEN by user direction):
 *     binding iff headroom > BINDING_HEADROOM_MIN AND ( the window's OWN
 *     per-channel 4× true peak (`measureFrameTruePeakDb`) is within
 *     BINDING_DELTA_DB of the global 4× true peak — SAME true-peak
 *     domain — OR the frame is the global-4×-TP frame, force-bound from
 *     `round(peakInputSample/hop)` );
 *   - a BINDING (active-band peak) frame runs the §Algorithm
 *     Specification Item-7 search (`searchBindingPeak`, Hong/Kim/Har
 *     2011 §3; `search.ts` UNFROZEN — its COMMIT OBJECTIVE is now the
 *     cross-channel 4× true-peak power, the Eq. 7–9 φ′ raw-sample
 *     recurrence kept as the candidate-proposal direction only) over the
 *     PER-CHANNEL windows with the supplied Item-7 stability bound λ;
 *     the COMMITTED scale (`searchResult.scale`) — the per-active-peak
 *     OPTIMAL decorrelation value — is emitted (commit-only-if-better on
 *     the 4× TP power — identity `c=0` is the guaranteed floor);
 *   - a NON-active frame's decorrelation amount is 0 ("for segments that
 *     do not have peaks in the active band the value should be 0"); it
 *     is also flagged non-binding in `bindingMask` (retained
 *     informational metadata).
 * The envelope is then bidirectionally zero-phase smoothed by the user
 * `smoothing` ms (`trajectory.ts` `smoothControlTrajectory`) BEFORE it
 * drives the streamed lattice — the gating to 0 in non-active segments
 * is what makes that smoothing predictable (it eases toward 0 across
 * gaps). There is NO `strength` (removed — the node always applies the
 * optimal value; λ is ALWAYS the full group-delay ceiling,
 * `search.lambda` from `groupDelayLambda`); the production applicator is
 * run at the literal `1` (an identity no-op at the call site — the
 * verbatim-transcription scalar of the byte-frozen kernel). Production
 * (`_process`) ALWAYS supplies `search`; the optional no-search branch
 * is the as-built fit walk retained as an unexercised defensive fallback
 * (currently no caller or test omits `search`).
 */
/**
 * Per-frame channel-sum window peak metadata captured DURING the
 * trajectory walk (zero extra cost — the driver already extracts the
 * `frameSize` window and computes `peakPriorityAmount` per frame to fit
 * the trajectory). The Phase-3 per-window delta gate (`utils/binding.ts`
 * `isBindingPeak`) classifies each frame from THIS + the whole-signal 4×
 * true peak, so the gate's headroom is bit-identical to the value the
 * fit saw for the same frame.
 */
export interface WindowPeak {
	/** The frame's channel-sum window max |peak| (linear). */
	readonly peakMagnitude: number;
	/**
	 * The frame's VERBATIM `peakPriorityAmount(window, 0, frameSize)` —
	 * the SAME value the trajectory fit used for this frame (∈ [0,1]).
	 */
	readonly headroom: number;
}

/**
 * Phase-4 Item-7 search parameters for the per-binding-peak coefficient
 * search wired into the trajectory walk (plan `### 4.2`). When supplied,
 * the driver runs the §Algorithm Specification Item-7 search on each
 * binding window and emits the committed scaled row; non-binding windows
 * emit identity rows + a non-binding `bindingMask` entry.
 */
export interface ItemSevenSearchParams {
	/**
	 * The whole-signal 4× true peak (dBTP) — the SAME single global
	 * measurement (`measureBufferTruePeakWithArgmax`). Used for the
	 * TP-driven gate predicate's proximity term (`isBindingPeak`).
	 */
	readonly globalTruePeakDb: number;
	/**
	 * The input-sample index of the global 4× true peak
	 * (`measureBufferTruePeakWithArgmax`) — the gate FORCE-BINDS the
	 * analysis frame `Math.round(peakInputSample / hopSize)` (robust to
	 * per-frame cold-history TP undercount; the 2026-05-17 keystone).
	 */
	readonly peakInputSample: number;
	/**
	 * The runtime sample rate (Hz) — for the per-frame
	 * {@link measureFrameTruePeakDb} (the gate's 4×-TP proximity LHS) and
	 * the Item-7 search's cross-channel 4× true-peak objective.
	 */
	readonly sampleRate: number;
	/**
	 * The Item-7 stability bound `λ ∈ (0,1)` — ALWAYS the full
	 * group-delay ceiling (`search.ts` `groupDelayLambda`; the 2026-05-17
	 * keystone removed the `strength` fraction — the node always applies
	 * the optimal value, no exposed group-delay-budget knob).
	 */
	readonly lambda: number;
}

export async function streamLatticeTrajectory(
	buffer: ChunkBuffer,
	frameSize: number,
	hopSize: number,
	backend?: FftBackend,
	addonOptions?: { vkfftPath?: string; fftwPath?: string },
	search?: ItemSevenSearchParams,
): Promise<{ trajectory: ControlTrajectory; frameCount: number; signalLength: number; windowPeaks: Array<WindowPeak>; bindingMask: Array<boolean> }> {
	const channelCount = buffer.channels;
	const signalLength = buffer.frames;
	const order = LATTICE_ORDER;
	const halfSize = frameSize / 2 + 1;
	const frameCount = stftFrameCount(signalLength, frameSize, hopSize);
	const identity = new Float32Array(order); // all-zero kₘ = the trivial all-pass

	// The PRE-SMOOTHING trajectory (Phase-8-defect FIX, 2026-05-17): the
	// per-frame BASE dispersive design row (`baseRows`, every frame) + the
	// SCALAR decorrelation amount (`amountEnv`: 0 non-active / the Item-7
	// committed `result.scale` at an active-band peak frame). `rows` is the
	// empty placeholder here — `smoothControlTrajectory` reconstructs the
	// smoothed `rows = finalAmount · baseRows` (the shape
	// `streamLatticeApply` consumes). The defective 8.2 reconstruction
	// stored a hard 0/spike per-lane row trajectory and bare-IIR'd it
	// (averaging sparse spikes away → a bit-identical no-op on real
	// content); the corrected envelope is the peak-respecting scalar amount.
	const baseRows = new Array<Float32Array>(frameCount);
	const amountEnv = new Float32Array(frameCount);
	const transientMask = new Float32Array(frameCount);
	// Per-frame ABSOLUTE peak-sample index `n_i` (the 2026-05-17
	// user-authoritative per-peak-exact CORRECTION): the absolute signal
	// sample index of THIS window's max |channel-sum| (= `f·hop +
	// argmax_pos`). Captured at zero extra cost in the same window scan
	// that already finds `WindowPeak.peakMagnitude`. Informational
	// metadata threaded into the trajectory so `smoothControlTrajectory`
	// can center each binding peak's exact-optimal flat hold on the
	// trajectory frame the PEAK SAMPLE interpolates from (`round(n_i /
	// hop)`), NOT the analysis frame f0. NO edit to the byte-frozen
	// `binding.ts`/`search.ts` (this is node-local trajectory metadata).
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
	// O(frames) per-frame channel-sum window peak metadata for the
	// Phase-3 gate (captured during the walk — zero extra cost; the
	// driver already extracts each window + computes `peakPriorityAmount`
	// to fit the trajectory).
	const windowPeaks = new Array<WindowPeak>(frameCount);
	// O(frames) per-frame binding classification (Phase 3 gate). With the
	// (always-supplied in production) `search` it is computed inline here
	// (and the search runs on the binding frames); the unexercised
	// no-search fallback leaves every frame defaulted binding.
	const bindingMask = new Array<boolean>(frameCount).fill(true);
	// The Item-7 scalable target PAPR η is derived WINDOW-RELATIVE inside
	// `searchBindingPeak` (a fraction of each window's OWN identity peak
	// power — `search.ts` `TARGET_PEAK_POWER_RATIO`); the driver does NOT
	// pass a global η (a global-true-peak η made the c₀=0 skip fire on
	// every window — a 0.000 dB no-op). `globalTruePeakDb` here is the
	// GATE's measurement only (`isBindingPeak`).

	if (frameCount === 0 || channelCount === 0) return { trajectory, frameCount, signalLength, windowPeaks, bindingMask };

	await buffer.reset();

	// `frameSize` ring of the linked-stereo sum + ONE `frameSize` ring
	// PER CHANNEL (the only audio-scale scratch — BOUNDED at
	// `(channelCount + 1) · frameSize`, NOT whole-signal; the 2026-05-17
	// keystone needs each channel's window for the per-frame 4× true-peak
	// gate term + the Item-7 cross-channel TP objective). `consumed`
	// counts samples so the contiguous window for frame `f`
	// (= signal[f·hop .. f·hop+frameSize)) can be extracted at the right
	// hop boundaries.
	const sumRing = new Float32Array(frameSize);
	const channelRings: Array<Float32Array> = Array.from({ length: channelCount }, () => new Float32Array(frameSize));
	const window = new Float32Array(frameSize);
	const channelWindows: Array<Float32Array> = Array.from({ length: channelCount }, () => new Float32Array(frameSize));
	const sumMagnitude = new Float32Array(halfSize);
	let consumed = 0; // total sum samples pushed into the ring
	let nextFrame = 0; // next analysis frame index to emit
	let previousEnergy = 0;

	let toRead = signalLength;

	while (toRead > 0 && nextFrame < frameCount) {
		const want = Math.min(WALK_CHUNK_FRAMES, toRead);
		const chunk = await buffer.read(want);
		const got = chunk.samples[0]?.length ?? 0;

		if (got === 0) break;

		for (let index = 0; index < got; index++) {
			// Linked-stereo sum — the SAME iterative Float32Array
			// channel-add as the as-built `sumChannels` (sum starts 0, each
			// channel added and stored as float32 in turn), so this sample
			// is bit-identical to the as-built `sumSignal[consumed]`.
			let sample = 0;

			const ringPos = consumed % frameSize;

			for (let ch = 0; ch < channelCount; ch++) {
				const value = chunk.samples[ch]?.[index] ?? 0;

				sample = Math.fround(sample + value);
				// Per-channel ring (bounded scratch) — the keystone gate's
				// per-frame 4× true peak + the Item-7 cross-channel TP
				// objective consume each channel's window.
				const channelRing = channelRings[ch];

				if (channelRing) channelRing[ringPos] = value;
			}

			sumRing[ringPos] = sample;
			consumed += 1;

			// Emit every frame whose `frameSize` window has just been fully
			// observed: frame `f` covers samples [f·hop, f·hop+frameSize), so
			// it is complete once `consumed === f·hop + frameSize`.
			while (nextFrame < frameCount && consumed >= nextFrame * hopSize + frameSize) {
				const start = nextFrame * hopSize;

				for (let pos = 0; pos < frameSize; pos++) window[pos] = sumRing[(start + pos) % frameSize] ?? 0;

				// Extract each channel's contiguous `frameSize` window from
				// its ring (the keystone gate's per-frame 4× true peak + the
				// Item-7 cross-channel TP objective; bounded scratch — the
				// same ring-unwrap as the sum window).
				for (let ch = 0; ch < channelCount; ch++) {
					const channelRing = channelRings[ch];
					const channelWindow = channelWindows[ch];

					if (!channelRing || !channelWindow) continue;

					for (let pos = 0; pos < frameSize; pos++) channelWindow[pos] = channelRing[(start + pos) % frameSize] ?? 0;
				}

				// VERBATIM single-frame STFT (bit-identical to the batch
				// `stft`'s frame `nextFrame`: identical windowed input, same
				// `fft`/addon path). `hopSize` is irrelevant for a single
				// frame (numFrames = 1).
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

				// VERBATIM per-frame fit (lattice.ts `extractLatticeTrajectory`
				// body, unchanged): the window is sumSignal[start ..
				// start+frameSize), so `peakPriorityAmount(window, 0,
				// frameSize)` === the as-built `peakPriorityAmount(sumSignal,
				// start, frameSize)` bit-for-bit.
				const amount = peakPriorityAmount(window, 0, frameSize);

				// Phase-3 gate metadata — the SAME `amount`
				// (`peakPriorityAmount(window, 0, frameSize)`) the fit
				// uses for this frame is reused VERBATIM as the gate's
				// headroom term (bit-identical to `classifyWindow` on the
				// same window), plus this window's max |peak|.
				let windowPeak = 0;
				// Position WITHIN the window of that max |sample| — the
				// argmax of the SAME scan that finds `windowPeak` (zero
				// extra cost). Absolute peak sample `n_i = start +
				// peakPos` (the 2026-05-17 per-peak-exact CORRECTION:
				// the exact hold is centered on this peak SAMPLE, not
				// the analysis frame). Ties keep the FIRST occurrence
				// (`>`, not `>=`) — deterministic, matching `windowPeak`.
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
				// Absolute peak-sample index `n_i` for this frame's
				// window (`start = nextFrame·hopSize`). Threaded into the
				// trajectory metadata; `smoothControlTrajectory` centers
				// the per-peak exact-optimal flat hold on `round(n_i /
				// hop)` — the trajectory frame the PEAK SAMPLE
				// interpolates from (NOT the analysis frame f0).
				peakSampleIndex[nextFrame] = start + peakPos;

				const delay = schroederTargetToDelay(sumMagnitude, amount);
				const { denominator } = designDispersionAllpass(delay, order);
				const reflection = stepDownToReflection(denominator);
				const row = new Float32Array(order);

				for (let section = 0; section < order; section++) row[section] = reflection[section] ?? 0;

				// The per-frame BASE dispersive design row (the Abel & Smith
				// / RMV step-down fit for THIS frame's spectrum) is stored
				// at EVERY frame, active or not (Phase-8-defect FIX,
				// 2026-05-17). The decorrelation AMOUNT (the scalar
				// `amountEnv`) scales it; `smoothControlTrajectory`
				// peak-respecting-smooths the SCALAR and reconstructs
				// `rows = finalAmount · baseRows`. Storing the base row
				// every frame is what lets an eased active value still
				// drive THAT frame's dispersive design across a gap (the
				// 8.2 defect stored only a hard 0/spike committed row, so
				// the bare IIR had nothing to ease toward but 0).
				baseRows[nextFrame] = row;

				if (search) {
					// --- Item-7 search + the TP-DRIVEN active-band GATE (the
					// 2026-05-17 KEYSTONE rework). Classify this frame by the
					// 4×-TRUE-PEAK gate predicate (`isBindingPeak`, composed;
					// `binding.ts` UNFROZEN by user direction): binding iff
					// `peakPriorityAmount` headroom > BINDING_HEADROOM_MIN AND
					// ( the window's OWN per-channel 4× true peak
					// (`measureFrameTruePeakDb`, fresh cold accumulator per
					// call — its mandatory contract) is within
					// BINDING_DELTA_DB of the global 4× true peak, SAME
					// true-peak domain — the old raw summed-sample LHS could
					// skip the very frame that determines the file's 4× TP —
					// OR this is the global-4×-TP frame (force-bind, robust to
					// per-frame cold-history TP undercount) ). A NON-active
					// frame's decorrelation amount is 0. An ACTIVE-band peak
					// frame runs the §Algorithm Specification Item-7 search
					// (`searchBindingPeak`, Hong/Kim/Har 2011 §3; `search.ts`
					// UNFROZEN — its COMMIT OBJECTIVE is now the cross-channel
					// 4× true-peak power, the Eq. 7–9 φ′ raw-sample recurrence
					// kept as the candidate-proposal direction only) over the
					// PER-CHANNEL windows: the search adapts the real scalar
					// `c` (`0 ≤ c < λ < 1`) FEEDING the Abel & Smith fit
					// (`row`) — it does NOT replace the fit or the RMV
					// step-down. `result.scale · row` is the committed row;
					// storing `result.scale` as `amountEnv` + `row` as
					// `baseRows` reproduces it as `amountEnv · baseRows`. The
					// scalar envelope is then combined by
					// `smoothControlTrajectory` before driving the lattice.
					// There is NO `strength` (removed — the node always
					// applies the optimal value; λ is ALWAYS the full
					// group-delay ceiling, `search.lambda`); the production
					// applicator runs at the literal `1`. `bindingMask` is
					// retained informational metadata.
					const frameTruePeakDb = measureFrameTruePeakDb(channelWindows, search.sampleRate);
					// Force-bind the analysis frame that contains the file's
					// global 4× true peak (`round(peakInputSample / hop)`).
					const isGlobalTpFrame = Math.round(search.peakInputSample / hopSize) === nextFrame;
					const bound = isBindingPeak(frameTruePeakDb, amount, search.globalTruePeakDb, isGlobalTpFrame);

					bindingMask[nextFrame] = bound;

					if (bound) {
						const result = searchBindingPeak(channelWindows, row, order, search.lambda);

						// The non-negative decorrelation amount at this
						// active-band peak frame (Item-7 committed scale —
						// `amountEnv · baseRows` ≡ the committed
						// `result.scale · row`, bit-identical).
						amountEnv[nextFrame] = result.scale;
					} else {
						// Decorrelation amount 0 at a non-active-band frame
						// ("for segments that do not have peaks in the
						// active band the value should be 0").
						amountEnv[nextFrame] = 0;
					}
				} else {
					// Unexercised no-search fallback (production always
					// supplies `search`): the base fit is applied at full
					// amount (amount 1 · baseRow = the unscaled Abel & Smith /
					// RMV fit row, the pre-Phase-4 behaviour).
					amountEnv[nextFrame] = 1;
				}

				nextFrame += 1;
			}
		}

		toRead -= got;
	}

	// Defensive: any frame not reached (cannot happen for a well-formed
	// buffer where `frames` matches the readable length) is identity — a
	// zero base row + zero decorrelation amount (⇒ an identity control
	// row after reconstruction) and an identity (zero-peak/zero-headroom)
	// gate metadatum so it classifies non-binding (exact identity).
	for (let frame = 0; frame < frameCount; frame++) {
		const wasReached = baseRows[frame] !== undefined;

		baseRows[frame] ??= new Float32Array(order);
		if (!wasReached) amountEnv[frame] = 0;
		windowPeaks[frame] ??= { peakMagnitude: 0, headroom: 0 };

		// An unreached frame (defensive — cannot happen for a well-formed
		// buffer) is exact identity ⇒ non-binding.
		if (search && !wasReached) bindingMask[frame] = false;
	}

	return { trajectory, frameCount, signalLength, windowPeaks, bindingMask };
}

/**
 * Run the time-varying normalized lattice all-pass over one streamed pass
 * of the disk-backed buffer, carrying the per-channel section state and
 * the absolute sample index ACROSS chunks, and hand each produced output
 * chunk to `onChunk`. The per-sample recurrence is transcribed VERBATIM
 * from `lattice.ts` `processLatticeChannel` (the verbatim-protected
 * kernel) — same frame-axis interpolation, same transcribed scalar, same
 * `MAX_REFLECTION` clamp, same orthogonal Givens section. A recursive
 * (IIR) filter's output depends only on its input and carried state, not
 * on how the input is buffered, so the streamed output is BIT-IDENTICAL
 * to `processLatticeChannel` over one contiguous array. NO whole-signal
 * array is allocated — output is emitted chunk-by-chunk.
 *
 * `onChunk` receives a fresh per-channel `Float32Array[]` of `got` frames
 * (bounded scratch, NOT accumulated here — the sole caller, `_process`,
 * writes it straight into the node-owned output `ChunkBuffer`). The
 * caller `reset()`s the buffer before this pass (a SINGLE production
 * pass — there is no whole-signal candidate-measurement pass after the
 * 2026-05-17 keystone).
 *
 * **The decorrelation-envelope model (Phase 8 / the 2026-05-17
 * user-authoritative correction — "essentially revert to what we had,
 * add the active band gating").** `smoothedTrajectory` IS the per-frame
 * decorrelation envelope AFTER bidirectional zero-phase smoothing
 * (`trajectory.ts` `smoothControlTrajectory`): a non-active-band frame's
 * row is 0 (identity), an active-band peak frame's is the Item-7 optimal
 * scaled row, and the whole thing is then eased toward 0 across gaps by
 * the user `smoothing` ms (so the bidirectional pass over large expanses
 * is predictable). This applicator simply runs the VERBATIM
 * `processLatticeChannel` per-sample recurrence over the WHOLE streamed
 * signal against that smoothed envelope — there is NO per-sample
 * binding-mask gate, NO exact-identity-input branch, and NO
 * frozen-state special-casing (the Phase-5 misread, withdrawn). A
 * non-active segment is just the lattice at (eased-to-)zero reflection
 * coefficients — a crest-invariant pure delay (an all-`kₘ ≈ 0` cascade
 * is `≈ z⁻ᴹ`; the as-built lattice identity contract — see
 * `processLatticeChannel`'s docstring). The bidirectional smoothing IS
 * the between-acted-windows easing; gating the envelope to 0 in
 * non-active segments is what makes that smoothing predictable (the
 * dead-notch was a NON-zero-gapped trajectory under the now-deleted
 * global never-worsen loop, not smoothing as such). There is NO
 * node-level bypass — the `strength` parameter and its `strength === 0`
 * early-return were removed by the 2026-05-17 keystone; the node always
 * runs this path (a wholly non-active signal is the lattice at
 * eased-to-zero coefficients — a crest-invariant pure delay).
 *
 * A recursive (IIR) filter's output depends only on its input and
 * carried state, not on how the input is buffered, so this streamed
 * output is BIT-IDENTICAL to `processLatticeChannel` over one contiguous
 * array.
 *
 * **The transcribed `scale` argument.** The per-sample recurrence is
 * transcribed VERBATIM from the byte-frozen `processLatticeChannel`,
 * whose signature bakes in a post-fit scalar `kCoeff = scale ·
 * interpolated`. The 2026-05-17 keystone removed the `strength` user
 * surface entirely; the per-peak optimal decorrelation amount is folded
 * into the committed trajectory rows by the Item-7 minimiser (λ-bounded,
 * `groupDelayLambda`), so the sole caller (`_process`) passes the
 * literal `1` here — an exact identity no-op at the call site
 * (`1 · interpolated = interpolated`) that keeps the recurrence, clamp,
 * and Givens section byte-faithful to the frozen kernel. The argument is
 * retained ONLY for that verbatim-transcription symmetry; it is an
 * internal arg, NOT a public surface, and there is no exposed
 * group-delay-budget knob (§Rejected Approaches).
 */
export async function streamLatticeApply(
	buffer: ChunkBuffer,
	smoothedTrajectory: ControlTrajectory,
	scale: number,
	order: number,
	hopSize: number,
	onChunk: (channels: Array<Float32Array>, got: number) => Promise<void> | void,
): Promise<void> {
	const channelCount = buffer.channels;
	const signalLength = buffer.frames;

	if (channelCount === 0 || signalLength === 0) return;

	const rows = smoothedTrajectory.rows;
	const frameCount = rows.length;
	// Per-channel z⁻¹ section state (the delayed `aₘ` of each first-order
	// section) — carried ACROSS chunks so the recursion is continuous.
	const state: Array<Float32Array> = Array.from({ length: channelCount }, () => new Float32Array(order));

	await buffer.reset();

	let sample = 0; // absolute sample index — carried across chunks
	let toRead = signalLength;
	// MAX_REFLECTION transcribed verbatim from lattice.ts (module-private
	// there); the streaming recurrence must clamp identically.
	const MAX_REFLECTION = 0.95;

	while (toRead > 0) {
		const want = Math.min(WALK_CHUNK_FRAMES, toRead);
		const chunk = await buffer.read(want);
		const got = chunk.samples[0]?.length ?? 0;

		if (got === 0) break;

		const out: Array<Float32Array> = Array.from({ length: channelCount }, () => new Float32Array(got));

		for (let index = 0; index < got; index++) {
			// Frame-axis → sample-axis linear interpolation of the smoothed
			// reflection-coefficient trajectory (VERBATIM from
			// `processLatticeChannel`: hop-spaced control points, the
			// absolute `sample` index drives `framePos`).
			const framePos = hopSize > 0 ? sample / hopSize : 0;
			const frame0 = Math.min(frameCount - 1, Math.max(0, Math.floor(framePos)));
			const frame1 = Math.min(frameCount - 1, frame0 + 1);
			const fraction = framePos - frame0;
			const row0 = rows[frame0] ?? smoothedTrajectory.identity;
			const row1 = rows[frame1] ?? smoothedTrajectory.identity;

			for (let ch = 0; ch < channelCount; ch++) {
				const inputValue = chunk.samples[ch]?.[index] ?? 0;
				const outChannel = out[ch];
				const chState = state[ch] ?? new Float32Array(order);
				let signalValue = inputValue;

				for (let section = 0; section < order; section++) {
					const interpolated = (row0[section] ?? 0) + fraction * ((row1[section] ?? 0) - (row0[section] ?? 0));
					let kCoeff = scale * interpolated;

					if (kCoeff > MAX_REFLECTION) kCoeff = MAX_REFLECTION;
					else if (kCoeff < -MAX_REFLECTION) kCoeff = -MAX_REFLECTION;

					const cCoeff = Math.sqrt(Math.max(0, 1 - kCoeff * kCoeff));
					const delayed = chState[section] ?? 0;
					// Orthogonal first-order normalized all-pass section
					// (RMV Fig. 4(b)) — energy-preserving every sample.
					const toDelay = cCoeff * signalValue + kCoeff * delayed; // → next sₘ
					const sectionOut = -kCoeff * signalValue + cCoeff * delayed; // → xₘ₊₁

					chState[section] = toDelay;
					signalValue = sectionOut;
				}

				if (outChannel) outChannel[index] = signalValue;
			}

			sample += 1;
		}

		await onChunk(out, got);
		toRead -= got;
	}
}
