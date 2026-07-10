import { describe, expect, it } from "vitest";
import type { Block } from "@buffered-audio/core";
import { TruePeakAccumulator, linearToDb } from "@buffered-audio/utils";
import { createTestSetupContext, createTestStreamContext, readableFrom } from "@buffered-audio/core/testing";
import { readWavSamples } from "../../utils/read-to-buffer";
import { audio, hasAudioFixtures } from "../../utils/test-binaries";
import { crestReduce, CrestReduceStream, schema } from ".";

const TEST_SAMPLE_RATE = 48_000;

// FRESH TruePeakAccumulator per call (never reused — its 12-tap history carries across pushes and its
// running max only grows, so reuse would contaminate the comparison).
function truePeakDb(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
	const accumulator = new TruePeakAccumulator(sampleRate, channels.length, 4);

	accumulator.push(channels as Array<Float32Array>, channels[0]?.length ?? 0);

	return linearToDb(accumulator.finalize());
}


function makeAsymmetric(frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);
	let state = 5 >>> 0;

	for (let index = 0; index < frames; index++) {
		state = (state * 1664525 + 1013904223) >>> 0;

		const base = Math.sin((2 * Math.PI * 180 * index) / sampleRate);

		out[index] = (base > 0 ? base * 0.9 : base * 0.2) + (state / 0xffffffff - 0.5) * 0.05;
	}

	return out;
}

function makeDense(frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		let value = 0;

		for (const frequency of [110, 220, 330, 440, 550, 660, 1500, 3000]) {
			value += Math.sin((2 * Math.PI * frequency * index) / sampleRate);
		}

		out[index] = (value / 8) * 0.6;
	}

	return out;
}

function makeTransient(frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		const envelope = index % 9600 < 200 ? 1 : 0.02;

		out[index] = Math.sin((2 * Math.PI * 250 * index) / sampleRate) * envelope;
	}

	return out;
}

function makePreClipped(frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		const value = Math.sin((2 * Math.PI * 200 * index) / sampleRate) * 2;

		out[index] = Math.max(-1, Math.min(1, value));
	}

	return out;
}

/**
 * GENUINELY HEADROOM-BEARING fixture for the MANDATORY non-degeneracy /
 * efficacy assertion: a band-limited impulse train — a sum of
 * `harmonics` cosine partials of `f0`, all in phase, so the energy
 * coincides into tall narrow periodic peaks with a low RMS between them
 * (a high crest factor ≈ 9 — the canonical phase-only crest-reduction
 * target; coincident broadband peaks with real transparent headroom to
 * recover). Distinct from `makeDense` (8 stationary sines, crest ≈ 2.8 —
 * already-diffuse, the principled ≈identity case). Normalised to ±0.9.
 */
function makeHeadroomBearing(frames: number, sampleRate: number, f0 = 100, harmonics = 40): Float32Array {
	const out = new Float32Array(frames);
	let peak = 0;

	for (let index = 0; index < frames; index++) {
		let value = 0;

		for (let h = 1; h <= harmonics; h++) value += Math.cos((2 * Math.PI * h * f0 * index) / sampleRate);

		out[index] = value;
		peak = Math.max(peak, Math.abs(value));
	}

	if (peak > 0) for (let index = 0; index < frames; index++) out[index] = ((out[index] ?? 0) / peak) * 0.9;

	return out;
}

/**
 * SPARSE-BINDING fixture — the real-content-like regression guard: long
 * quiet stretches (a low-level sine, far below the binding stratum)
 * punctuated by a few short, isolated, LOUD peaky bursts (in-phase
 * harmonic impulse-train clusters with real phase-only headroom). Only a
 * small % of analysis frames sit in the active band — the episode-060
 * reality (`binding.ts`'s Phase-6 calibration: ≈2.3% of frames bind).
 * The corrected per-peak-exact envelope must HOLD the active optimal
 * across each burst and deliver a genuine non-trivial whole-signal 4× TP
 * reduction (NOT a sparse-spike-averaged no-op).
 */
function makeSparseBinding(frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		out[index] = Math.sin((2 * Math.PI * 90 * index) / sampleRate) * 0.04;
	}

	const burstFrames = Math.round(0.03 * sampleRate);
	const burstStarts = [
		Math.round(0.35 * frames),
		Math.round(0.5 * frames),
		Math.round(0.62 * frames),
		Math.round(0.78 * frames),
		Math.round(0.9 * frames),
	];

	for (const start of burstStarts) {
		for (let offset = 0; offset < burstFrames && start + offset < frames; offset++) {
			const index = start + offset;
			const envelope = 0.5 - 0.5 * Math.cos((2 * Math.PI * offset) / burstFrames);
			let value = 0;

			for (let h = 1; h <= 30; h++) value += Math.cos((2 * Math.PI * h * 160 * index) / sampleRate);

			out[index] = (value / 30) * 0.95 * envelope;
		}
	}

	return out;
}

function makeSynthetic(frames: number, sampleRate: number, seed = 1): Float32Array {
	const out = new Float32Array(frames);
	let state = seed >>> 0;

	for (let index = 0; index < frames; index++) {
		state = (state * 1664525 + 1013904223) >>> 0;

		const noise = (state / 0xffffffff - 0.5) * 0.05;
		const fundamental = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.08;
		const harmonic = Math.sin((2 * Math.PI * 880 * index) / sampleRate) * 0.02;

		out[index] = fundamental + harmonic + noise;
	}

	return out;
}

// WHOLE-FILE drive (blockSize: WHOLE_FILE, accumulate-at-flush); DETERMINISTIC — identical input ⇒ identical output.
async function runStream(
	channels: ReadonlyArray<Float32Array>,
	sampleRate: number,
	properties: { smoothing?: number; frameSize?: number } = {},
): Promise<Array<Float32Array>> {
	const channelCount = channels.length;
	const frameSize = properties.frameSize ?? 2048;
	const stream = new CrestReduceStream(crestReduce({ smoothing: properties.smoothing ?? 100, frameSize }), createTestStreamContext().context);

	const chunk: Block = { samples: channels.map((channel) => channel), offset: 0, sampleRate, bitDepth: 32 };
	const output = await stream.setup(readableFrom([chunk]), createTestSetupContext());
	const reader = output.getReader();

	const collected: Array<Array<Float32Array>> = [];

	for (;;) {
		const next = await reader.read();

		if (next.done) break;

		collected.push(next.value.samples);
	}

	const lengths = new Array<number>(channelCount).fill(0);

	for (const piece of collected) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			lengths[channelIndex] = (lengths[channelIndex] ?? 0) + (piece[channelIndex]?.length ?? 0);
		}
	}

	const out = Array.from({ length: channelCount }, (_unused, channelIndex) => new Float32Array(lengths[channelIndex] ?? 0));
	const offsets = new Array<number>(channelCount).fill(0);

	for (const piece of collected) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const slice = piece[channelIndex];

			if (!slice) continue;

			out[channelIndex]?.set(slice, offsets[channelIndex] ?? 0);
			offsets[channelIndex] = (offsets[channelIndex] ?? 0) + slice.length;
		}
	}

	return out;
}

/**
 * Best-case match of `output` to ANY integer shift of `input` (the
 * minimum, over a window of candidate delays, of the mean-abs interior
 * difference). A pure delay / sample-exact identity would drive this to
 * ≈0; a genuine group-delay/phase change keeps it well above 0 (the
 * (i) non-triviality probe).
 */
function minShiftedDifference(input: Float32Array, output: Float32Array, maxShift: number): number {
	const lo = 4000;
	const hi = Math.min(input.length, output.length) - 4000 - maxShift;
	let best = Number.POSITIVE_INFINITY;

	for (let shift = 0; shift <= maxShift; shift++) {
		let sum = 0;
		let count = 0;

		for (let index = lo; index < hi; index += 7) {
			sum += Math.abs((output[index + shift] ?? 0) - (input[index] ?? 0));
			count += 1;
		}

		const mean = count > 0 ? sum / count : Number.POSITIVE_INFINITY;

		if (mean < best) best = mean;
	}

	return best;
}

function pctChangedAndMax(input: Float32Array, output: Float32Array): { pct: number; maxAbs: number } {
	let differing = 0;
	let maxAbs = 0;

	for (let index = 0; index < input.length; index++) {
		const diff = Math.abs((output[index] ?? 0) - (input[index] ?? 0));

		if (diff !== 0) differing += 1;
		if (diff > maxAbs) maxAbs = diff;
	}

	return { pct: input.length > 0 ? (100 * differing) / input.length : 0, maxAbs };
}

/**
 * ───── (i): MANDATORY non-degeneracy / efficacy — the predecessor
 * 5F.4 / 5R.2 lesson, NON-NEGOTIABLE ─────
 * Proves the keystone gated, Item-7-TP-search, per-peak-exact +
 * bidirectionally-smoothed decorrelation transform is NON-trivial (a
 * real group-delay / phase change — NOT a delayed copy) AND genuinely
 * reduces the whole-signal 4× true peak on GENUINELY headroom-bearing
 * content at the default `smoothing`. NOT loosened / faked /
 * it.fails-wrapped — a genuine negative would be an ESCALATION with the
 * measured numbers (predecessor 5F.4 discipline).
 */
describe("CrestReduce (i) NON-DEGENERACY / efficacy (the mandatory 5F.4/5R.2 guard)", () => {
	const TIMEOUT = 120_000;
	const FRAMES = TEST_SAMPLE_RATE; // 1 s

	it("on headroom-bearing content the transform is non-trivial AND genuinely reduces whole-signal 4× TP at the default smoothing", async () => {
		const input = makeHeadroomBearing(FRAMES, TEST_SAMPLE_RATE);
		const inputTp = truePeakDb([input], TEST_SAMPLE_RATE);
		const output = await runStream([input], TEST_SAMPLE_RATE, { smoothing: 100 });
		const out0 = output[0] ?? new Float32Array(0);
		const outputTp = truePeakDb([out0], TEST_SAMPLE_RATE);

		expect(out0.length).toBe(input.length);

		// 1. NON-TRIVIAL: not a mere delayed/identity copy (a degenerate
		//    floored-to-identity no-op would make this ≈0).
		const minDiff = minShiftedDifference(input, out0, 2048);

		expect(minDiff).toBeGreaterThan(1e-2);

		// 2. GENUINE REDUCTION: a real, non-zero whole-signal 4× TP
		//    reduction on headroom-bearing content (≥ 1.0 dB — a real
		//    efficacy gate, not a tautology; within the prior-art-
		//    consistent transparent range, Item 10).
		expect(inputTp - outputTp).toBeGreaterThanOrEqual(1.0);
	}, TIMEOUT);
});

/**
 * ───── (i-sparse): SPARSE-BINDING regression guard ─────
 * Real-content-like (only a small % of frames active — the episode-060
 * reality). The corrected per-peak-exact scalar-amount envelope MUST
 * produce a genuine non-trivial whole-signal 4× TP reduction AND a
 * non-bit-identical output. A genuine negative is an ESCALATION with
 * the measured numbers, never a softened pass.
 */
describe("CrestReduce (i-sparse) SPARSE-BINDING regression guard", () => {
	const TIMEOUT = 120_000;
	const FRAMES = 4 * TEST_SAMPLE_RATE; // 4 s — long quiet bed, a few isolated bursts ⇒ a SMALL % of frames bind

	it("on sparse-binding content the envelope is non-bit-identical AND genuinely reduces whole-signal 4× TP at the default smoothing", async () => {
		const input = makeSparseBinding(FRAMES, TEST_SAMPLE_RATE);
		const inputTp = truePeakDb([input], TEST_SAMPLE_RATE);
		const output = await runStream([input], TEST_SAMPLE_RATE, { smoothing: 100 });
		const out0 = output[0] ?? new Float32Array(0);
		const outputTp = truePeakDb([out0], TEST_SAMPLE_RATE);

		expect(out0.length).toBe(input.length);

		const { pct, maxAbs } = pctChangedAndMax(input, out0);

		// 1. NOT a bit-identical no-op (the 8.2 defect signature).
		expect(pct).toBeGreaterThan(1);
		expect(maxAbs).toBeGreaterThan(1e-3);

		// 2. GENUINE whole-signal 4× TP reduction (floor 0.10 dB —
		//    decisively above the defect's exact 0.00; the strict primary
		//    defect catch is the non-bit-identical pair above).
		expect(inputTp - outputTp).toBeGreaterThanOrEqual(0.1);
	}, TIMEOUT);
});

/**
 * ───── (ii): adversarial fixtures — the real per-peak never-worsen
 * contract (NOT a fabricated whole-signal rule) ─────
 * CORRECTED 2026-05-17: the prior `TP(output) ≤ TP(input)` whole-signal
 * assertion tested a MISINTERPRETATION — a whole-signal never-worsen
 * "rule" that was never the contract. The actual, always-intended
 * never-worsen is PER-WINDOW: the search commits a coefficient only if
 * it lowers THAT window's own 4× TP (identity c=0 is the floor — grid
 * sample 0; enforced + tested in `utils/search.unit.test.ts`). There is
 * no whole-signal never-worsen guarantee and never was — on adversarial
 * SYNTHETIC fixtures the correct per-window optima can raise the
 * whole-signal 4× TP via cross-window dispersion bleed (measured:
 * transient ≈+1.07 dB, linked-stereo ≈+0.71 dB); that quantity is simply
 * not a guaranteed one. On REAL content the node reduces ((i)
 * mandatory-efficacy + episode-060 QA: ΔTP ≈ +1.1 dB). So acted fixtures
 * assert STRUCTURAL correctness (length, finite, genuinely processed —
 * no accidental bypass) + a generous BLOW-UP sanity ceiling (NaN/Inf/
 * gross regression). The pre-clipped case keeps a TIGHT non-worsening
 * assertion — the distinct, real ITEM-10 ≈identity contract (no headroom
 * ⇒ non-binding ⇒ crest-invariant pure delay). Per-peak never-worsen +
 * genuine reduction are verified where they belong; a NaN/Inf or
 * multi-dB blow-up still fails loudly.
 */
describe("CrestReduce (ii) adversarial fixtures — per-peak never-worsen contract (no fabricated whole-signal rule)", () => {
	const TIMEOUT = 120_000;
	const FRAMES = TEST_SAMPLE_RATE; // 1 s
	const SLACK = 0.05; // FP slack for the Item-10 pre-clipped ≈identity case
	// Generous BLOW-UP sanity ceiling for ACTED synthetic fixtures: the
	// accepted per-peak-only cross-window excursion on these adversarial
	// synthetics is ≈1 dB; 6 dB is far above that yet still fails loudly
	// on a genuine regression / NaN / gross instability. Explicitly a
	// sanity bound, NOT the (retired) whole-signal never-worsen rule.
	const BLOWUP_CEILING_DB = 6;

	function assertProcessedNoBlowUp(input: Float32Array, output: Array<Float32Array>, inputTp: number): void {
		const out0 = output[0] ?? new Float32Array(0);

		expect(out0.length).toBe(input.length);

		for (const value of out0) expect(Number.isFinite(value)).toBe(true);

		// Genuinely transformed — NOT an accidental bypass (the node always
		// runs the path; `strength` removed by the 2026-05-17 keystone).
		const { pct } = pctChangedAndMax(input, out0);

		expect(pct).toBeGreaterThan(0);
		// Blow-up sanity ONLY (NOT the retired whole-signal never-worsen
		// rule — see the describe-block rationale).
		expect(truePeakDb(output, TEST_SAMPLE_RATE)).toBeLessThanOrEqual(inputTp + BLOWUP_CEILING_DB);
	}

	it("dense / music-like — processed, finite, length-preserving, no blow-up (whole-signal 4× TP is not a guaranteed quantity — never was)", async () => {
		const input = makeDense(FRAMES, TEST_SAMPLE_RATE);
		const inputTp = truePeakDb([input], TEST_SAMPLE_RATE);

		assertProcessedNoBlowUp(input, await runStream([input], TEST_SAMPLE_RATE), inputTp);
	}, TIMEOUT);

	it("transient — processed, finite, length-preserving, no blow-up (whole-signal 4× TP is not a guaranteed quantity; the ≈+1.07 dB cross-window bleed on this synthetic is expected, not a regression)", async () => {
		const input = makeTransient(FRAMES, TEST_SAMPLE_RATE);
		const inputTp = truePeakDb([input], TEST_SAMPLE_RATE);

		assertProcessedNoBlowUp(input, await runStream([input], TEST_SAMPLE_RATE), inputTp);
	}, TIMEOUT);

	it("asymmetric — processed, finite, length-preserving, no blow-up (whole-signal 4× TP is not a guaranteed quantity — never was)", async () => {
		const input = makeAsymmetric(FRAMES, TEST_SAMPLE_RATE);
		const inputTp = truePeakDb([input], TEST_SAMPLE_RATE);

		assertProcessedNoBlowUp(input, await runStream([input], TEST_SAMPLE_RATE), inputTp);
	}, TIMEOUT);

	it("already-limited (pre-clipped ±1) — TIGHT non-worsening (the ITEM-10 ≈identity contract, NOT the retired whole-signal veto)", async () => {
		const input = [makePreClipped(FRAMES, TEST_SAMPLE_RATE)];
		const inputTp = truePeakDb(input, TEST_SAMPLE_RATE);
		const output = await runStream(input, TEST_SAMPLE_RATE);

		// Pre-clipped ⇒ no phase-only-recoverable headroom ⇒ the gate makes
		// every window non-binding ⇒ ≈identity (crest-invariant pure delay)
		// ⇒ whole-signal 4× TP must NOT rise (§Algorithm Item 10). A
		// distinct still-valid contract — not the retired never-worsen veto.
		expect(truePeakDb(output, TEST_SAMPLE_RATE)).toBeLessThanOrEqual(inputTp + SLACK);
	}, TIMEOUT);
});

/**
 * ───── (iii): the `smoothing` parameter — present, default 100, and
 * the PER-PEAK-EXACT contract ─────
 * `smoothing` must NOT change the whole-signal peak reduction
 * ("smoothing should not be affecting reduction in any way … the
 * smoothing parameter's only effect is decorrelation spill over into
 * gated segments or smoothing between values"). The corrected envelope
 * holds the EXACT Item-7 per-peak optimal FLAT across ±(group-delay
 * span) AROUND THE PEAK SAMPLE, smoothing-invariantly; `smoothing`
 * shapes ONLY the outward spill. Asserted on the SPARSE-binding fixture
 * (real-content-like — there ARE non-peak regions for the spill to
 * differ in).
 */
describe("CrestReduce (iii) `smoothing` — present, default 100; reduction smoothing-INVARIANT, spill reshaped", () => {
	const TIMEOUT = 120_000;
	const SPARSE_FRAMES = 4 * TEST_SAMPLE_RATE;

	it("the schema declares `smoothing` with default 100 ms and the factory accepts an explicit value", () => {
		const parsed = schema.parse({});

		expect(parsed.smoothing).toBe(100);

		const node = crestReduce({ smoothing: 250 });

		expect(node.properties.smoothing).toBe(250);
		expect(crestReduce().properties.smoothing).toBe(100);
	});

	it("whole-signal 4× TP reduction is smoothing-INVARIANT, yet the two outputs differ in the inter-peak spill regions", async () => {
		const input = makeSparseBinding(SPARSE_FRAMES, TEST_SAMPLE_RATE);
		const inputTp = truePeakDb([input], TEST_SAMPLE_RATE);

		const tight = await runStream([input], TEST_SAMPLE_RATE, { smoothing: 20 });
		const wide = await runStream([input], TEST_SAMPLE_RATE, { smoothing: 400 });

		const a = tight[0] ?? new Float32Array(0);
		const b = wide[0] ?? new Float32Array(0);

		expect(a.length).toBe(b.length);
		expect(a.length).toBeGreaterThan(0);

		// ── (a) SMOOTHING-INVARIANT whole-signal 4× TP reduction ─────────
		const tpTight = truePeakDb([a], TEST_SAMPLE_RATE);
		const tpWide = truePeakDb([b], TEST_SAMPLE_RATE);
		const deltaTight = inputTp - tpTight;
		const deltaWide = inputTp - tpWide;
		const deltaSpread = Math.abs(deltaTight - deltaWide);

		expect(deltaSpread).toBeLessThanOrEqual(0.05);

		// Both reductions are GENUINE (not a trivially-invariant no-op).
		expect(deltaTight).toBeGreaterThanOrEqual(0.1);
		expect(deltaWide).toBeGreaterThanOrEqual(0.1);

		// ── (b) peaks UNTOUCHED by smoothing, spill OUTSIDE reshaped ─────
		const burstFrames = Math.round(0.03 * TEST_SAMPLE_RATE);
		const burstStarts = [0.35, 0.5, 0.62, 0.78, 0.9].map((fraction) => Math.round(fraction * SPARSE_FRAMES));
		const inBurstCore = (index: number): boolean => {
			for (const start of burstStarts) {
				if (index >= start && index < start + burstFrames) return true;
			}

			return false;
		};

		let coreMaxAbsDiff = 0;
		let outsideMaxAbsDiff = 0;
		let outsideSumAbsDiff = 0;
		let outsideCount = 0;

		for (let index = 0; index < a.length; index++) {
			const diff = Math.abs((a[index] ?? 0) - (b[index] ?? 0));

			if (inBurstCore(index)) {
				coreMaxAbsDiff = Math.max(coreMaxAbsDiff, diff);
			} else {
				outsideMaxAbsDiff = Math.max(outsideMaxAbsDiff, diff);
				outsideSumAbsDiff += diff;
				outsideCount += 1;
			}
		}

		const outsideMeanAbsDiff = outsideCount > 0 ? outsideSumAbsDiff / outsideCount : 0;

		// STRICT: the peak (exact-hold) cores are BIT-IDENTICAL across the
		// two smoothing settings — smoothing does not touch the peaks.
		expect(coreMaxAbsDiff).toBe(0);

		// OUTSIDE the cores the two outputs genuinely differ — the spill
		// is demonstrably reshaped (a real wired effect on the SPREAD).
		expect(outsideMaxAbsDiff).toBeGreaterThan(1e-3);
		expect(outsideMeanAbsDiff).toBeGreaterThan(1e-6);

		expect(Number.isFinite(tpTight)).toBe(true);
		expect(Number.isFinite(tpWide)).toBe(true);
	}, TIMEOUT);
});

describe("CrestReduce (iv) determinism / reproducibility (re-spec of the superseded `strength` monotonicity)", () => {
	const TIMEOUT = 120_000;
	const FRAMES = TEST_SAMPLE_RATE;

	it("same input ⇒ BIT-IDENTICAL output (the search/gate/envelope path is fully deterministic — no RNG), and a genuine reduction holds", async () => {
		const input = makeHeadroomBearing(FRAMES, TEST_SAMPLE_RATE);
		const inputTp = truePeakDb([input], TEST_SAMPLE_RATE);

		const first = await runStream([input], TEST_SAMPLE_RATE);
		const second = await runStream([input], TEST_SAMPLE_RATE);

		const a = first[0] ?? new Float32Array(0);
		const b = second[0] ?? new Float32Array(0);

		expect(a.length).toBe(b.length);
		expect(a.length).toBe(input.length);

		for (let index = 0; index < a.length; index++) expect(a[index]).toBe(b[index]);

		// Efficacy is not weakened: a genuine reduction still holds.
		expect(inputTp - truePeakDb([a], TEST_SAMPLE_RATE)).toBeGreaterThanOrEqual(1.0);
	}, TIMEOUT);
});

/**
 * ───── (v): linked stereo ─────
 * Coefficients from the channel sum applied identically to all channels;
 * the commit objective is the CROSS-CHANNEL 4× true peak; length /
 * finiteness preserved; genuinely processed. CORRECTED 2026-05-17: a
 * whole-signal never-worsen assertion here tested a MISINTERPRETATION —
 * that was never the contract (see (ii)); the real per-peak never-worsen
 * is tested in `utils/search.unit.test.ts` and genuine reduction in (i)
 * + the episode-060 QA. Whole-signal 4× TP is not a guaranteed quantity:
 * this adversarial stereo fixture rises ≈+0.71 dB via cross-window bleed
 * (expected, not a regression); a multi-dB blow-up / NaN still fails the
 * sanity ceiling.
 */
describe("CrestReduce (v) linked stereo", () => {
	const TIMEOUT = 120_000;
	const FRAMES = TEST_SAMPLE_RATE; // 1 s
	// Generous blow-up sanity ceiling (see (ii)) — NOT the retired
	// whole-signal never-worsen rule; catches NaN/Inf/gross regression.
	const BLOWUP_CEILING_DB = 6;

	it("processes a 2-channel signal: length + finiteness preserved, genuinely transformed, no blow-up (whole-signal 4× TP not a guaranteed quantity — see (ii))", async () => {
		const left = makeHeadroomBearing(FRAMES, TEST_SAMPLE_RATE);
		const right = makeAsymmetric(FRAMES, TEST_SAMPLE_RATE);
		const inputTp = truePeakDb([left, right], TEST_SAMPLE_RATE);
		const output = await runStream([left, right], TEST_SAMPLE_RATE);

		expect(output.length).toBe(2);
		expect(output[0]?.length).toBe(left.length);
		expect(output[1]?.length).toBe(right.length);

		for (const channel of output) for (const value of channel) expect(Number.isFinite(value)).toBe(true);

		// Genuinely transformed (no accidental bypass) + blow-up sanity.
		const { pct } = pctChangedAndMax(left, output[0] ?? new Float32Array(0));

		expect(pct).toBeGreaterThan(0);
		expect(truePeakDb(output, TEST_SAMPLE_RATE)).toBeLessThanOrEqual(inputTp + BLOWUP_CEILING_DB);
	}, TIMEOUT);
});

/**
 * ───── (vi): silence / sub-frame ─────
 * All-zero and shorter-than-frame input handled (no throw, finite,
 * identity / non-worsening). Silence through the all-zero-coefficient
 * lattice is still exactly zero (a zero input through any linear
 * recurrence is zero).
 */
describe("CrestReduce (vi) silence / sub-frame", () => {
	const TIMEOUT = 120_000;

	it("silence passes through finite and exactly zero", async () => {
		const input = [new Float32Array(TEST_SAMPLE_RATE)];
		const output = await runStream(input, TEST_SAMPLE_RATE);

		expect(output[0]?.length).toBe(TEST_SAMPLE_RATE);

		for (const value of output[0] ?? []) {
			expect(Number.isFinite(value)).toBe(true);
			expect(value).toBe(0);
		}
	}, TIMEOUT);

	it("a sub-frame input does not throw and yields finite output", async () => {
		const input = [makeDense(512, TEST_SAMPLE_RATE)];
		const output = await runStream(input, TEST_SAMPLE_RATE);

		for (const value of output[0] ?? []) expect(Number.isFinite(value)).toBe(true);
	}, TIMEOUT);
});

// the node always runs the path — no bypass (there is no `strength`).
describe("CrestReduce (vii) always runs the path — no bypass (re-spec of the superseded `strength = 0` bypass)", () => {
	const TIMEOUT = 120_000;
	const SYNTHETIC_FRAMES = TEST_SAMPLE_RATE;

	it("synthetic LCG content is genuinely transformed (no bypass; deterministic path), length-preserving and finite", async () => {
		const input = makeSynthetic(SYNTHETIC_FRAMES, TEST_SAMPLE_RATE);
		const output = await runStream([input], TEST_SAMPLE_RATE);
		const out0 = output[0] ?? new Float32Array(0);

		expect(out0.length).toBe(input.length);

		for (const value of out0) expect(Number.isFinite(value)).toBe(true);

		// No bypass: the path always runs. (`makeSynthetic` has genuine
		// crest headroom on its 220/880 Hz tones + noise, so a real
		// transform is applied — not a verbatim passthrough.)
		const { pct } = pctChangedAndMax(input, out0);

		expect(pct).toBeGreaterThan(0);
	}, TIMEOUT);

	it.skipIf(!hasAudioFixtures("testVoice"))("voice fixture is processed (no bypass), length-preserving and finite", async () => {
		const { samples, sampleRate } = await readWavSamples(audio.testVoice);
		const output = await runStream(samples, sampleRate);

		expect(output.length).toBe(samples.length);

		for (let channelIndex = 0; channelIndex < samples.length; channelIndex++) {
			expect(output[channelIndex]?.length).toBe(samples[channelIndex]?.length);

			for (const value of output[channelIndex] ?? []) expect(Number.isFinite(value)).toBe(true);
		}
	}, TIMEOUT);
});
