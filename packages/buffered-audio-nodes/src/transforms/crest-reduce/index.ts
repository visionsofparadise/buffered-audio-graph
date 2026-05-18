import { z } from "zod";
import { BufferedTransformStream, ChunkBuffer, TransformNode, WHOLE_FILE, type AudioChunk, type StreamContext, type TransformNodeProperties } from "@e9g/buffered-audio-nodes-core";
import { initFftBackend, type FftBackend } from "@e9g/buffered-audio-nodes-utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { LATTICE_ORDER } from "./utils/lattice";
import { groupDelayLambda } from "./utils/search";
import { exactHoldHalfWidthFrames, smoothControlTrajectory, trajectoryFrameRate } from "./utils/trajectory";
// `measureBufferTruePeakWithArgmax` is the single global 4× TP + the
// input-sample index of that peak (the 2026-05-17 keystone: the
// TP-driven gate force-binds the analysis frame containing the file's
// global 4× true peak). There is NO whole-signal never-worsen veto and
// no whole-signal candidate-measurement pass — the 2026-05-17
// user-authoritative LOCKED model: the ONLY never-worsen is the
// per-window commit-only-if-better intrinsic to the deterministic Item-7
// minimiser (`searchBindingPeak`).
import { measureBufferTruePeakWithArgmax, streamLatticeApply, streamLatticeTrajectory } from "./utils/windowed";

// Power-of-two predicate for the `frameSize` constraint. The analysis-side
// STFT (the per-frame magnitude feeding the Abel & Smith fit) runs the JS
// FFT fallback when no native addon is present, which is power-of-2 only
// (the FFT addon paths below are the optional accelerators, as for
// de-bleed). No shared power-of-two util exists in the codebase, so a tiny
// local predicate is used (no new shared surface needed).
function isPowerOfTwo(value: number): boolean {
	return value > 0 && (value & (value - 1)) === 0;
}

export const schema = z.object({
	smoothing: z
		.number()
		.min(0)
		.default(100)
		.describe(
			"Bidirectional (zero-phase) smoothing time constant in ms applied to the per-frame decorrelation envelope before it drives the lattice (default 100 ms). The envelope is 0 in segments with no active-band peak and the per-binding-peak optimal value at active-band peaks; smoothing eases it toward 0 across gaps so the bidirectional pass is predictable. Applied to the CONTROL trajectory only — never the audio path",
		),
	frameSize: z
		.number()
		.int()
		.refine(isPowerOfTwo, { message: "frameSize must be a power of two" })
		.default(2048)
		.describe("Analysis frame length in samples (default 2048 @ 48 kHz ≈ 43 ms; 75% overlap, Hann analysis window). Whole-file processing — output is produced after the full input is accumulated"),
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
});

export interface CrestReduceProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class CrestReduceStream extends BufferedTransformStream<CrestReduceProperties> {
	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };

	/**
	 * Whole-file transformed output as a node-owned, disk-backed
	 * `ChunkBuffer` (the `loudnessTarget` `winningSmoothedEnvelopeBuffer`
	 * precedent — NOT a stream-resident full-length `Float32Array`, which
	 * was the design-streaming.md materialization anti-pattern Phase 2
	 * removes). `_process` writes the produced output here at flush;
	 * `_unbuffer` serves it chunk-by-chunk. `null` when the stream passes
	 * through (no audio or a sub-frame input — there is no `strength`
	 * bypass after the 2026-05-17 keystone; the node always runs the
	 * gate/search/lattice path), in which case `_unbuffer` emits the
	 * input verbatim (the length-preserving passthrough fallback).
	 */
	private outputBuffer: ChunkBuffer | null = null;

	/**
	 * Set `true` by the first `_unbuffer` call so `outputBuffer`'s read
	 * cursor is rewound exactly once (it is at end-of-buffer after
	 * `_process`'s streaming production write). Rewound lazily in
	 * `_unbuffer` — after `_process` finished — not eagerly, so a stable
	 * cursor state exists (the `loudnessTarget` `unbufferCursorsReady`
	 * precedent).
	 */
	private unbufferCursorReady = false;

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<ReadableStream<AudioChunk>> {
		const fft = initFftBackend(context.executionProviders, this.properties);

		this.fftBackend = fft.backend;
		this.fftAddonOptions = fft.addonOptions;

		return super._setup(input, context);
	}

	private get hopSize(): number {
		return this.properties.frameSize / 4;
	}

	/**
	 * Whole-file processing at flush (the `loudnessTarget` accumulate-then-
	 * process precedent — `bufferSize === WHOLE_FILE`, so the framework hands
	 * the ENTIRE accumulated signal in one `_process` call). The SINGLE
	 * realization (2026-05-16 FUNDAMENTAL REFRAME — the normalized
	 * Gray–Markel lossless-lattice phase rotator; `spectral` and the
	 * `realization` parameter removed):
	 *
	 * The 2026-05-17 KEYSTONE rework — SINGLE-PASS, per-binding-peak
	 * Item-7 search over a TP-DRIVEN gate and a TP-DRIVEN commit
	 * objective; NO `strength` (the node always applies the optimal
	 * value); NO whole-signal never-worsen veto (the only never-worsen
	 * is the per-window commit-only-if-better intrinsic to the Item-7
	 * search):
	 *
	 *   1. WHOLE-SIGNAL 4× true peak + its input-sample index measured
	 *      ONCE — a SEQUENTIAL CHUNKED WALK driving per-channel BS.1770-4
	 *      4× `TruePeakUpsampler`s directly
	 *      (`measureBufferTruePeakWithArgmax`; 12-tap history carries
	 *      across `upsample` so chunk boundaries are invisible). The dBTP
	 *      is the gate's proximity reference; `peakInputSample`
	 *      force-binds the analysis frame containing the file's global
	 *      4× true peak.
	 *   2. EXTRACT + TP-DRIVEN GATE + ITEM-7 SEARCH, one streaming
	 *      sliding-window pass — `streamLatticeTrajectory(buffer, …,
	 *      { globalTruePeakDb, peakInputSample, sampleRate, lambda })`: a
	 *      `frameSize` ring of the linked-stereo sum + ONE per channel,
	 *      computed on the fly (NO whole-signal array). Per hop the
	 *      grounded Abel & Smith (Item 9) + RMV §III step-down (Item 8)
	 *      reflection row is fitted VERBATIM; the frame is classified by
	 *      the TP-DRIVEN gate predicate (`isBindingPeak` —
	 *      `peakPriorityAmount` headroom AND ( the window's OWN
	 *      per-channel 4× true peak within BINDING_DELTA_DB of the global
	 *      4× true peak, SAME true-peak domain — OR the global-4×-TP
	 *      frame, force-bound ); `binding.ts` UNFROZEN); an ACTIVE-band
	 *      peak frame runs the §Algorithm Specification Item-7 search
	 *      (`searchBindingPeak`, Hong/Kim/Har 2011 §3; `search.ts`
	 *      UNFROZEN — its COMMIT OBJECTIVE is the cross-channel 4×
	 *      true-peak power, the Eq. 7–9 φ′ raw-sample recurrence kept as
	 *      the candidate-proposal direction only) over the PER-CHANNEL
	 *      windows with the FULL group-delay-ceiling λ — its committed
	 *      scale (commit-only-if-better on the 4× TP power; identity
	 *      `c=0` is the guaranteed floor) is the per-active-peak OPTIMAL
	 *      decorrelation value; a NON-active frame's envelope value is 0.
	 *      There is NO `strength` (λ is ALWAYS the full ceiling,
	 *      `groupDelayLambda`). The O(frames) trajectory IS the
	 *      decorrelation envelope (the ONLY resident product besides
	 *      bounded scratch).
	 *   2b. COMBINE the envelope (the 2026-05-17 PER-PEAK-EXACT model):
	 *      `smoothControlTrajectory` = `max` of a per-peak EXACT-OPTIMAL
	 *      flat hold centered on the PEAK SAMPLE `n_i` (half-width
	 *      `exactHoldHalfWidthFrames(sampleRate, hopSize)` — the
	 *      group-delay span, NEVER `smoothing`) that pins the EXACT
	 *      Item-7 optimal at every binding peak so whole-signal
	 *      true-peak reduction is `smoothing`-INVARIANT, and a
	 *      `smoothing`-driven bidirectional zero-phase SPILL
	 *      (transient-asymmetry pullback pre-pass THEN forward+backward
	 *      `BidirectionalIir` on the trajectory's FRAME-RATE axis,
	 *      τ = (ms/1000)·√2 internal to `BidirectionalIir`) whose ONLY
	 *      effect is decorrelation spill into the gated gaps + easing
	 *      between active values. HARD RULE (design §Rejected
	 *      Approaches): both passes are on the CONTROL trajectory ONLY —
	 *      NEVER the audio.
	 *   3. ONE streaming PRODUCTION pass over the committed
	 *      per-peak-exact + bidirectionally-SMOOTHED decorrelation
	 *      envelope. `streamLatticeApply` is the byte-faithful
	 *      `processLatticeChannel` transcription (lattice.ts BYTE-FROZEN)
	 *      and is called with the literal `1` for its internal
	 *      transcribed scalar (an identity no-op at the call site — an
	 *      internal arg of the verbatim transcription, NOT a public
	 *      surface; there is no `strength`). There is NO whole-signal
	 *      never-worsen veto (removed — the per-window
	 *      commit-only-if-better in the Item-7 search is the only
	 *      never-worsen) and NO per-sample binding gate / edge crossfade:
	 *      a non-active segment is the lattice at eased-to-zero
	 *      coefficients (a crest-invariant pure delay). Each output chunk
	 *      is written straight into the node-owned output `ChunkBuffer`
	 *      (served chunk-by-chunk by `_unbuffer`). The streamed lattice
	 *      output is BIT-IDENTICAL to processing one contiguous array.
	 *
	 * NO whole-signal `Float32Array` exists anywhere — the
	 * design-streaming.md materialization anti-pattern is GENUINELY
	 * eliminated (not relocated). Resident state: the O(frames) trajectory
	 * + mask + bounded ring (sum + per-channel) / accumulator / chunk
	 * scratch.
	 *
	 * There is NO node-level bypass (the `strength` parameter and its
	 * `strength <= 0` early-return were removed by the 2026-05-17
	 * keystone). The only passthrough is the length-preserving fallback
	 * for no audio / a sub-frame input (no analysis frame fits) —
	 * `_unbuffer` then emits the input verbatim.
	 */
	override async _process(buffer: ChunkBuffer): Promise<void> {
		const { frameSize, smoothing } = this.properties;

		// No `strength` (removed 2026-05-17 keystone — the node ALWAYS
		// applies the optimal value: the per-binding-peak Item-7 search
		// over the 4× true-peak objective + commit-only-if-better decide
		// the realised decorrelation; identity `c=0` is the guaranteed
		// per-window floor). There is no node-level bypass; the gate/
		// search/lattice path always runs (a wholly non-active signal is
		// the lattice at eased-to-zero coefficients — a crest-invariant
		// pure delay; the sub-frame / no-audio passthrough fallback stays
		// below).
		const channelCount = buffer.channels;
		const totalFrames = buffer.frames;

		if (channelCount === 0 || totalFrames === 0) return;

		const sampleRate = buffer.sampleRate ?? this.sampleRate ?? 48000;
		const order = LATTICE_ORDER;
		const hopSize = this.hopSize;

		// --- 1. WHOLE-SIGNAL 4× true peak + its input-sample index -------
		// A SEQUENTIAL CHUNKED WALK driving per-channel BS.1770-4 4×
		// `TruePeakUpsampler`s directly (one cold instance per channel for
		// the whole walk — its 12-tap history carries across `upsample`
		// calls so chunk boundaries are invisible, FP-identical running
		// max to a single `TruePeakAccumulator`). It returns both the
		// global 4× true peak (dBTP) AND the input-sample index of that
		// peak (phase-0 impulse-aligned). The 2026-05-17 keystone: the
		// TP-driven gate uses the dBTP for its proximity term AND
		// force-binds the analysis frame containing the file's global 4×
		// true peak (`round(peakInputSample / hop)`) — robust to
		// per-frame cold-history TP undercount. NO whole-signal
		// `Float32Array` (a bounded per-channel upsampled chunk only).
		const { db: inputTpDb, peakInputSample } = await measureBufferTruePeakWithArgmax(buffer, sampleRate);

		// --- 2. EXTRACT + TP-DRIVEN GATE + ITEM-7 SEARCH (one pass) ------
		// `streamLatticeTrajectory` walks the disk-backed `ChunkBuffer`
		// ONCE (2026-05-12 sequential-only API: `read(n)`/`reset()`, no
		// offset, no `read(total)`), maintaining a `frameSize` ring of the
		// linked-stereo sum + ONE per channel (bounded scratch — NO whole
		// `sumSignal` array). Per hop the grounded Abel & Smith (Item 9) +
		// RMV §III step-down (Item 8) reflection row is fitted VERBATIM;
		// the frame is classified by the TP-DRIVEN gate predicate
		// (`isBindingPeak` — `peakPriorityAmount` headroom AND ( the
		// window's OWN per-channel 4× true peak within BINDING_DELTA_DB of
		// the global 4× true peak, SAME true-peak domain — OR the global-
		// 4×-TP frame, force-bound )); a BINDING frame runs the §Algorithm
		// Specification Item-7 search (Hong/Kim/Har 2011 §3) over the
		// PER-CHANNEL windows with the FULL group-delay-ceiling λ, its
		// COMMIT OBJECTIVE the cross-channel 4× true-peak power
		// (commit-only-if-better — identity `c=0` is the guaranteed
		// floor); a NON-binding frame's decorrelation amount is 0. There
		// is NO `strength` (removed — the node always applies the optimal
		// value; λ is ALWAYS the full ceiling, `groupDelayLambda`). The
		// O(frames) trajectory + mask are the only resident product (NO
		// whole-signal `Float32Array`).
		const lambda = groupDelayLambda(sampleRate, order);
		const { trajectory, frameCount } = await streamLatticeTrajectory(buffer, frameSize, hopSize, this.fftBackend, this.fftAddonOptions, {
			globalTruePeakDb: inputTpDb,
			peakInputSample,
			sampleRate,
			lambda,
		});

		if (frameCount === 0) {
			// Sub-frame input: no analysis frame fits. Identity passthrough
			// (length-preserving — `_unbuffer` falls back to the input).
			return;
		}

		// --- 2b. SMOOTH the decorrelation envelope (Phase 8 / the
		// 2026-05-17 user-authoritative PER-PEAK-EXACT correction) -------
		// `trajectory` IS the per-frame decorrelation envelope: 0 at every
		// non-active-band frame, the Item-7 per-active-peak optimal value
		// at active-band peak frames (the gate, `binding.ts`, UNCHANGED).
		// `smoothControlTrajectory` combines, by `max`, a PER-PEAK
		// EXACT-OPTIMAL flat hold centered on the PEAK SAMPLE `n_i`
		// (`peakSampleIndex`, threaded from the analysis walk — held flat
		// across `[round(n_i/hop) − Wexact, round(n_i/hop) + Wexact]`,
		// half-width `Wexact = exactHoldHalfWidthFrames(sampleRate,
		// hopSize)` = the decorrelation's OWN group-delay span
		// (GROUP_DELAY_CEILING_MS + analysis geometry), depending ONLY on
		// the group-delay ceiling + geometry, NEVER on `smoothing`), which
		// pins the EXACT Item-7 optimal at every binding peak so
		// whole-signal true-peak reduction is `smoothing`-INVARIANT, with
		// a `smoothing`-driven bidirectional zero-phase SPILL (transient
		// pullback → `BidirectionalIir`) whose ONLY effect is
		// decorrelation spill into the gated gaps + the gradient between
		// ungapped values (the user's authoritative model: "smoothing
		// should not be affecting reduction … the smoothing parameter's
		// only effect is decorrelation spill over into gated segments or
		// smoothing between values"). HARD RULE (design §Rejected
		// Approaches): the per-peak hold spread, the transient pullback,
		// and the `BidirectionalIir` pass are on the CONTROL trajectory
		// ONLY — NEVER the audio (forward-backward an all-pass = identity,
		// cancelling the mechanism). A wholly non-active signal ⇒ the
		// envelope is all-zero ⇒ the lattice is a crest-invariant pure
		// delay (there is no node-level bypass — `strength` removed by the
		// 2026-05-17 keystone). `frameSize` is destructured at the top of
		// `_process`; `hopSize` is the member getter — both already
		// available (no recompute); `Wexact` is derived from `sampleRate`/
		// `hopSize` (NOT `frameSize`/`smoothing`).
		const smoothed = smoothControlTrajectory(trajectory, smoothing, trajectoryFrameRate(sampleRate, hopSize), exactHoldHalfWidthFrames(sampleRate, hopSize), hopSize);

		// --- 3. PRODUCE (no whole-signal never-worsen veto) --------------
		// The ONLY never-worsen is the per-window commit-only-if-better
		// INTRINSIC to the deterministic minimiser (`searchBindingPeak` +
		// Parker–Välimäki §III-A read per-window — the committed scale
		// never raises THAT window's own 4× true-peak power FOR THE
		// ISOLATED search evaluation; identity `c=0` is its floor). SCOPE
		// CAVEAT (known-issue B, measured): production is a stateful
		// frame-interpolated lattice, so the REALISED per-window 4× TP can
		// marginally exceed identity (episode-060: ≈5% of binding windows,
		// mean ≈+0.22 dB) — NOT a bit-strict rendered-output guarantee
		// (see `search.ts` `searchBindingPeak` SCOPE CAVEAT; the
		// conservative 0.07%/+1.1 dB gate bounds its impact). There is NO
		// whole-signal never-worsen (the earlier `_process` veto was
		// removed — it was never a real contract). `_process` ALWAYS emits
		// the gated + per-peak-exact + smoothed lattice output. Streaming
		// is intact
		// (the production path stays chunked/streamed below, no
		// whole-signal materialization).

		// --- 4. ONE streaming PRODUCTION pass ----------------------------
		// Stream the buffer through the recursive lattice over the
		// per-peak-exact + bidirectionally-SMOOTHED decorrelation envelope
		// (`smoothed`). `streamLatticeApply` is the byte-faithful
		// `processLatticeChannel` transcription (lattice.ts BYTE-FROZEN);
		// its internal transcribed scalar is passed the literal `1` (an
		// identity no-op at the call site — an internal arg of the
		// verbatim transcription, NOT a public surface; there is NO
		// `strength`). The smoothed envelope IS the whole control path: a
		// non-active segment is the lattice at eased-to-zero coefficients
		// (a crest-invariant pure delay); there is NO per-sample binding
		// gate, NO exact-identity-input branch, and NO edge crossfade.
		// Each output chunk is written straight into a node-owned,
		// disk-backed `ChunkBuffer` (the `loudnessTarget`
		// `winningSmoothedEnvelopeBuffer` precedent — NOT a
		// stream-resident `Array<Float32Array>`). `_unbuffer` serves it
		// chunk-by-chunk. NO whole-signal array at any point.
		const out = new ChunkBuffer();

		await streamLatticeApply(buffer, smoothed, 1, order, hopSize, async (channels, got) => {
			await out.write(
				channels.map((channel) => (channel.length === got ? channel : channel.subarray(0, got))),
				sampleRate,
			);
		});
		await out.flushWrites();

		if (out.frames > 0) this.outputBuffer = out;
		else await out.close();
	}

	/**
	 * Serve the whole-file transformed output sequentially in chunk cadence
	 * from the node-owned disk-backed `ChunkBuffer` (the `loudnessTarget`
	 * `_unbuffer` precedent — read forward in chunk-cadence lockstep with
	 * upstream chunks; NO overlap re-feed since `bufferSize === WHOLE_FILE`).
	 * When no transform was produced (no audio or a sub-frame input —
	 * there is no `strength` bypass after the 2026-05-17 keystone) the
	 * input chunk is emitted VERBATIM — the length-preserving passthrough
	 * fallback (nothing mutated, same backing arrays).
	 */
	override async _unbuffer(chunk: AudioChunk): Promise<AudioChunk | undefined> {
		const output = this.outputBuffer;
		const length = chunk.samples[0]?.length ?? 0;

		if (output === null || output.frames === 0 || length === 0) return chunk;

		// Rewind the output buffer's read cursor on the first `_unbuffer`
		// call — it is at end-of-buffer after `_process`'s never-worsen
		// measurement. Done lazily here (after `_process` finished) so a
		// stable cursor state exists (the `loudnessTarget`
		// `unbufferCursorsReady` precedent).
		if (!this.unbufferCursorReady) {
			await output.reset();
			this.unbufferCursorReady = true;
		}

		const transformedChunk = await output.read(length);
		const transformed = transformedChunk.samples;

		const samples = chunk.samples.map((inputChannel, ch) => transformed[ch] ?? inputChannel);

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}

	/**
	 * Idempotent cleanup of the node-owned output `ChunkBuffer` so its
	 * backing temp file is released on EVERY exit path — not only graceful
	 * end-of-stream (the 2026-05-12 `_teardown`-guaranteed-cleanup
	 * Decision; the `loudnessTarget` precedent). `BufferedTransformStream`
	 * already closes its own accumulation `chunkBuffer` in `teardown()`;
	 * this node-owned extra buffer needs its own release.
	 */
	override async _teardown(): Promise<void> {
		if (this.outputBuffer !== null) {
			await this.outputBuffer.close();
			this.outputBuffer = null;
		}
	}
}

export class CrestReduceNode extends TransformNode<CrestReduceProperties> {
	static override readonly moduleName = "Crest Reduce";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Content-adaptive, magnitude-preserving, phase-only crest-factor reducer — a pre-limiter headroom stage that rearranges signal phase to flatten true-peak excursions without changing the magnitude spectrum, never increasing crest factor";
	static override readonly schema = schema;
	static override is(value: unknown): value is CrestReduceNode {
		return TransformNode.is(value) && value.type[2] === "crest-reduce";
	}

	override readonly type = ["buffered-audio-node", "transform", "crest-reduce"] as const;

	constructor(properties: CrestReduceProperties) {
		// Whole-file (the `loudnessTarget` precedent): accumulate the entire
		// input, process at flush, emit. NOT streaming/overlap — the
		// bidirectional control-trajectory smoothing and the single
		// whole-signal 4× true-peak measurement (the gate's proximity
		// reference + global-TP-frame force-bind) both require the full
		// signal (2026-05-16 whole-file pivot).
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): CrestReduceStream {
		return new CrestReduceStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<CrestReduceProperties>): CrestReduceNode {
		return new CrestReduceNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function crestReduce(options?: { smoothing?: number; frameSize?: number; vkfftAddonPath?: string; fftwAddonPath?: string; id?: string }): CrestReduceNode {
	const parsed = schema.parse(options ?? {});

	return new CrestReduceNode({ ...parsed, id: options?.id });
}
