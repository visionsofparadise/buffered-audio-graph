import { ChunkBuffer } from "@e9g/buffered-audio-nodes-core";
import { TruePeakAccumulator, linearToDb } from "@e9g/buffered-audio-nodes-utils";
import { describe, expect, it } from "vitest";
import { BINDING_DELTA_DB, BINDING_HEADROOM_MIN, classifyWindow, isBindingPeak, measureWholeSignalTruePeakDb } from "./binding";

// ─────────────────────────────────────────────────────────────────────
// crest-reduce binding-gate suite — RE-SPEC'd to the 2026-05-17 KEYSTONE
// rework (user-directed): the gate is now in the 4×-TRUE-PEAK domain.
// `classifyWindow(channelWindows, globalTruePeakDb, sampleRate,
// isGlobalTpFrame)` and `isBindingPeak(frameTruePeakDb, headroom,
// globalTruePeakDb, isGlobalTpFrame)`: binding iff
//   headroom > BINDING_HEADROOM_MIN
//   AND ( frameTruePeakDb >= globalTruePeakDb − BINDING_DELTA_DB
//         OR isGlobalTpFrame )
// — SAME true-peak domain on both sides (the old raw summed-sample LHS
// was a different domain and could skip the very frame that determines
// the file's 4× true peak), plus a force-bind of the global-4×-TP frame.
// The pre-clipped zero-headroom fixture is STILL non-binding via the
// headroom term. NOT loosened / faked / it.fails / skipped.
// ─────────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const HOP_SIZE = FRAME_SIZE / 4;

/**
 * Reference whole-signal 4× true peak (dBTP) — a SINGLE fresh
 * `TruePeakAccumulator` over the contiguous samples (the
 * `utils/objective.ts` fresh-accumulator discipline). The streaming
 * `measureWholeSignalTruePeakDb` must equal THIS to FP (the per-channel
 * upsampler's 12-tap history carries across `upsample`, so a chunked
 * walk and one contiguous push produce the identical running max).
 */
function referenceTruePeakDb(channels: ReadonlyArray<Float32Array>): number {
	const accumulator = new TruePeakAccumulator(SAMPLE_RATE, channels.length, 4);

	accumulator.push(channels as Array<Float32Array>, channels[0]?.length ?? 0);

	return linearToDb(accumulator.finalize());
}

/** A FRESH-accumulator 4× true peak (dBTP) of one window's channels. */
function windowTruePeakDb(channels: ReadonlyArray<Float32Array>): number {
	const accumulator = new TruePeakAccumulator(SAMPLE_RATE, Math.max(1, channels.length), 4);

	accumulator.push(channels as Array<Float32Array>, channels[0]?.length ?? 0);

	return linearToDb(accumulator.finalize());
}

/**
 * GENUINELY HEADROOM-BEARING — the `makeHeadroomBearing` shape from
 * `unit.test.ts`: a band-limited cosine impulse train (all partials in
 * phase ⇒ tall narrow periodic peaks, low RMS between).
 */
function makeHeadroomBearing(frames: number, sampleRate: number, f0 = 100, harmonics = 40): Float32Array {
	const out = new Float32Array(frames);
	let peak = 0;

	for (let index = 0; index < frames; index++) {
		let value = 0;

		for (let harmonic = 1; harmonic <= harmonics; harmonic++) value += Math.cos((2 * Math.PI * harmonic * f0 * index) / sampleRate);

		out[index] = value;
		peak = Math.max(peak, Math.abs(value));
	}

	if (peak > 0) for (let index = 0; index < frames; index++) out[index] = ((out[index] ?? 0) / peak) * 0.9;

	return out;
}

/**
 * ALREADY-LIMITED — the `makePreClipped` shape from `unit.test.ts`: a
 * hard-clipped 200 Hz sine (every window's sample peak = exactly ±1).
 * Crest ≈ 1.13 < √2 ⇒ `peakPriorityAmount` = 0.0000 — the load-bearing
 * zero-crest-headroom case (NON-binding via the headroom term, the
 * design's principled ≈identity-on-already-limited outcome, Item 10).
 */
function makePreClipped(frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		const value = Math.sin((2 * Math.PI * 200 * index) / sampleRate) * 2;

		out[index] = Math.max(-1, Math.min(1, value));
	}

	return out;
}

/** Stationary diffuse — the `makeDense` shape (8 summed sines, crest ≈ 2.8). */
function makeDense(frames: number, sampleRate: number): Float32Array {
	const out = new Float32Array(frames);

	for (let index = 0; index < frames; index++) {
		let value = 0;

		for (const frequency of [110, 220, 330, 440, 550, 660, 1500, 3000]) value += Math.sin((2 * Math.PI * frequency * index) / sampleRate);

		out[index] = (value / 8) * 0.6;
	}

	return out;
}

/**
 * Synthetic high-crest IMPULSE TRAIN — a periodic unit spike (a ±0.95
 * peak every 4800 samples) on a quiet noise floor. The few windows
 * straddling a spike sit at the global true peak (binding); the long
 * quiet runs between spikes are tens of dB below it (non-binding).
 */
function makeImpulseTrain(frames: number, period: number): Float32Array {
	const out = new Float32Array(frames);
	let state = 7 >>> 0;

	for (let index = 0; index < frames; index++) {
		state = (state * 1664525 + 1013904223) >>> 0;
		out[index] = (state / 0xffffffff - 0.5) * 0.002; // quiet floor
	}

	for (let index = 0; index < frames; index += period) out[index] = index % (2 * period) === 0 ? 0.95 : -0.95;

	return out;
}

/** Per-window binding classification across a whole signal (mono). */
function classifySignal(signal: Float32Array, globalTruePeakDb: number): Array<ReturnType<typeof classifyWindow>> {
	const count = signal.length < FRAME_SIZE ? 0 : Math.floor((signal.length - FRAME_SIZE) / HOP_SIZE) + 1;
	const out: Array<ReturnType<typeof classifyWindow>> = [];

	for (let frame = 0; frame < count; frame++) {
		out.push(classifyWindow([signal.subarray(frame * HOP_SIZE, frame * HOP_SIZE + FRAME_SIZE)], globalTruePeakDb, SAMPLE_RATE));
	}

	return out;
}

describe("BINDING_DELTA_DB / BINDING_HEADROOM_MIN — the declared internal QA constants", () => {
	it("are single positive declared defaults (Phase-6 calibration inputs, NOT exposed; the gate is now TP-domain)", () => {
		expect(BINDING_DELTA_DB).toBe(3);
		expect(BINDING_DELTA_DB).toBeGreaterThan(0);
		expect(BINDING_HEADROOM_MIN).toBe(0.5);
	});
});

describe("classifyWindow — TP-domain per-window gate (4×-true-peak proximity OR global-TP force-bind, AND headroom)", () => {
	it("flags a high-crest window whose own 4× true peak is AT the global true peak as binding, with correct peak metadata", () => {
		const window = new Float32Array(FRAME_SIZE);

		for (let index = 0; index < FRAME_SIZE; index++) window[index] = Math.sin((2 * Math.PI * 200 * index) / SAMPLE_RATE) * 0.1;

		window[1234] = -0.8; // the in-window peak (signed)

		// Global TP = this window's own 4× true peak ⇒ proximity holds.
		const globalTpDb = windowTruePeakDb([window]);
		const result = classifyWindow([window], globalTpDb, SAMPLE_RATE);

		expect(result.binding).toBe(true);
		expect(result.peakIndex).toBe(1234);
		// `Float32Array` stores `Math.fround(-0.8)`; compare loosely.
		expect(result.peakValue).toBeCloseTo(-0.8, 6);
		expect(result.peakMagnitude).toBeCloseTo(0.8, 6);
		// A single tall spike on a quiet sine ⇒ huge crest ⇒ headroom ≈ 1.
		expect(result.headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		// The reported frame 4× true peak is its own measured value.
		expect(result.frameTruePeakDb).toBeCloseTo(windowTruePeakDb([window]), 6);
	});

	it("flags a window whose own 4× true peak is more than BINDING_DELTA_DB below the global as non-binding (and NOT the global-TP frame)", () => {
		const window = new Float32Array(FRAME_SIZE).fill(0);

		window[10] = 0.1; // ~ −20 dB

		// Global true peak is 0 dBFS; the window's own 4× TP (≈ −20 dB) is
		// far more than BINDING_DELTA_DB (3 dB) below it ⇒ non-binding via
		// the PROXIMITY term (not the global-TP frame ⇒ no force-bind).
		const result = classifyWindow([window], linearToDb(1), SAMPLE_RATE, false);

		expect(result.binding).toBe(false);
		expect(result.peakIndex).toBe(10);
		expect(result.peakMagnitude).toBeCloseTo(0.1, 6);
	});

	it("the global-4×-TP frame is FORCE-BOUND even if its own 4× TP would be below the proximity band (robust to cold-history undercount)", () => {
		const window = makeHeadroomBearing(FRAME_SIZE, SAMPLE_RATE).subarray(0, FRAME_SIZE) as Float32Array;
		// A global TP far ABOVE this window's own 4× true peak so the
		// proximity term FAILS — only the force-bind can bind it.
		const farGlobalDb = windowTruePeakDb([window]) + 50;

		const notForced = classifyWindow([window], farGlobalDb, SAMPLE_RATE, false);
		const forced = classifyWindow([window], farGlobalDb, SAMPLE_RATE, true);

		expect(notForced.binding).toBe(false); // proximity fails, not forced
		expect(forced.headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		expect(forced.binding).toBe(true); // force-bind the global-TP frame
	});

	it("a zero-headroom window is NON-binding even when force-flagged the global-TP frame (the headroom term is conjunctive)", () => {
		const clipped = new Float32Array(FRAME_SIZE);

		for (let index = 0; index < FRAME_SIZE; index++) clipped[index] = Math.max(-1, Math.min(1, Math.sin((2 * Math.PI * 200 * index) / SAMPLE_RATE) * 2));

		// Even the force-bind cannot override zero crest headroom (a
		// phase-only all-pass cannot flatten an already-limited window).
		const forced = classifyWindow([clipped], windowTruePeakDb([clipped]), SAMPLE_RATE, true);

		expect(forced.headroom).toBe(0);
		expect(forced.binding).toBe(false);
	});

	it("is exactly on the binding 4×-TP PROXIMITY boundary at globalTp − BINDING_DELTA_DB (inclusive)", () => {
		const window = new Float32Array(FRAME_SIZE);

		window[0] = 0.5;
		// A single 0.5 spike in zeros ⇒ huge crest ⇒ headroom ≈ 1 ≫ min,
		// so the binding flips purely on the 4×-TP-delta proximity term.
		const ownTpDb = windowTruePeakDb([window]);

		const onEdge = classifyWindow([window], ownTpDb + BINDING_DELTA_DB, SAMPLE_RATE, false);
		const justOver = classifyWindow([window], ownTpDb + BINDING_DELTA_DB + 0.01, SAMPLE_RATE, false);

		expect(onEdge.headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		expect(onEdge.binding).toBe(true); // `>=` proximity boundary is inclusive
		expect(justOver.binding).toBe(false);
	});

	it("classifies a silent / empty window as non-binding", () => {
		expect(classifyWindow([new Float32Array(FRAME_SIZE)], linearToDb(0.5), SAMPLE_RATE).binding).toBe(false);

		const empty = classifyWindow([new Float32Array(0)], linearToDb(0.5), SAMPLE_RATE);

		expect(empty.binding).toBe(false);
		expect(empty.peakIndex).toBe(-1);
		expect(empty.peakMagnitude).toBe(0);
		expect(empty.headroom).toBe(0);
	});
});

describe("classifyWindow — the HEADROOM term (binding = ( TP-proximity OR force-bind ) AND phase-only-recoverable crest headroom)", () => {
	it("a genuinely ZERO-crest-headroom window AT the global true peak is NON-binding (exact identity) — the load-bearing case", () => {
		const clipped = new Float32Array(FRAME_SIZE);

		for (let index = 0; index < FRAME_SIZE; index++) clipped[index] = Math.max(-1, Math.min(1, Math.sin((2 * Math.PI * 200 * index) / SAMPLE_RATE) * 2));

		const result = classifyWindow([clipped], windowTruePeakDb([clipped]), SAMPLE_RATE);

		expect(result.headroom).toBe(0); // genuinely zero crest headroom
		expect(result.binding).toBe(false); // ⇒ non-binding via the headroom term
	});

	it("a HIGH-crest headroom-bearing window AT the global true peak IS binding (the genuine phase-only target)", () => {
		const window = makeHeadroomBearing(FRAME_SIZE, SAMPLE_RATE).subarray(0, FRAME_SIZE) as Float32Array;
		const result = classifyWindow([window], windowTruePeakDb([window]), SAMPLE_RATE);

		expect(result.headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		expect(result.binding).toBe(true);
	});

	it("`isBindingPeak` is the EXACT ( headroom AND ( TP-proximity OR force-bind ) ) predicate `classifyWindow` applies", () => {
		// Same rule, factored for the streaming driver (it classifies from
		// the cheap per-frame 4× TP / headroom it already computed).
		const window = makeHeadroomBearing(FRAME_SIZE, SAMPLE_RATE).subarray(0, FRAME_SIZE) as Float32Array;
		const ownTpDb = windowTruePeakDb([window]);

		// proximate + headroom ⇒ bind.
		const proxBind = classifyWindow([window], ownTpDb, SAMPLE_RATE, false);

		expect(isBindingPeak(proxBind.frameTruePeakDb, proxBind.headroom, ownTpDb, false)).toBe(proxBind.binding);
		expect(proxBind.binding).toBe(true);

		// far below + not forced ⇒ non-bind.
		const farDb = ownTpDb + 50;
		const farClassify = classifyWindow([window], farDb, SAMPLE_RATE, false);

		expect(isBindingPeak(farClassify.frameTruePeakDb, farClassify.headroom, farDb, false)).toBe(farClassify.binding);
		expect(farClassify.binding).toBe(false);

		// far below but FORCE-bound (global-TP frame) ⇒ bind (headroom ok).
		const forced = classifyWindow([window], farDb, SAMPLE_RATE, true);

		expect(isBindingPeak(forced.frameTruePeakDb, forced.headroom, farDb, true)).toBe(forced.binding);
		expect(forced.binding).toBe(true);

		// The headroom-threshold strictness (`> BINDING_HEADROOM_MIN`):
		expect(isBindingPeak(linearToDb(0.5), BINDING_HEADROOM_MIN, linearToDb(0.5), false)).toBe(false); // exactly at min ⇒ NOT binding
		expect(isBindingPeak(linearToDb(0.5), BINDING_HEADROOM_MIN + 1e-6, linearToDb(0.5), false)).toBe(true); // just over ⇒ binding
		expect(isBindingPeak(linearToDb(1), 0, linearToDb(1), true)).toBe(false); // zero headroom even when forced ⇒ NOT binding
	});
});

describe("the gate on fixtures (high-crest binds; already-limited is all-identity via the headroom term)", () => {
	const FRAMES = SAMPLE_RATE; // 1 s

	it("a synthetic high-crest impulse-train fixture's peak windows are binding (and the quiet runs are not)", () => {
		const signal = makeImpulseTrain(FRAMES, 4800);
		const globalTpDb = referenceTruePeakDb([signal]);
		const windows = classifySignal(signal, globalTpDb);

		const bindingCount = windows.filter((window) => window.binding).length;

		// SOME windows bind (the ones straddling a spike) …
		expect(bindingCount).toBeGreaterThan(0);
		// … but NOT all — the long quiet runs between spikes are tens of
		// dB down ⇒ non-binding (a real classifier, not constant-true).
		expect(bindingCount).toBeLessThan(windows.length);
		for (const window of windows) if (window.binding) expect(window.peakMagnitude).toBeGreaterThan(0.5);
	});

	it("a `makeHeadroomBearing` fixture has binding peak windows (4×-TP-proximate AND `peakPriorityAmount` = 1)", () => {
		const signal = makeHeadroomBearing(FRAMES, SAMPLE_RATE);
		const windows = classifySignal(signal, referenceTruePeakDb([signal]));

		expect(windows.some((window) => window.binding)).toBe(true);
		expect(windows.every((window) => window.headroom > BINDING_HEADROOM_MIN)).toBe(true);
	});

	it("an already-limited (pre-clipped ±1) fixture has ALL windows non-binding ⇒ exact identity (Item-10) — via the HEADROOM term", () => {
		const signal = makePreClipped(FRAMES, SAMPLE_RATE);
		const globalTpDb = referenceTruePeakDb([signal]);
		const windows = classifySignal(signal, globalTpDb);

		// A clipped (square-ish) waveform has crest ≈ 1.13 < √2 ⇒
		// `peakPriorityAmount` = 0.0000 ⇒ NO phase-only-recoverable
		// headroom ⇒ NON-binding regardless of proximity. (The keystone
		// put the proximity LHS in the 4×-TP domain — but the headroom
		// term is the load-bearing one here, conjunctive and decisive.)
		expect(windows.every((window) => window.headroom === 0)).toBe(true);
		expect(windows.every((window) => !window.binding)).toBe(true);
	});

	it("a mildly-diffuse `makeDense` fixture is ALL-non-binding at the calibrated BINDING_HEADROOM_MIN = 0.5 (its `peakPriorityAmount` ≈0.31–0.40 < 0.5) — the principled ≈identity-on-diffuse Item-10 outcome", () => {
		const signal = makeDense(FRAMES, SAMPLE_RATE);
		const windows = classifySignal(signal, referenceTruePeakDb([signal]));

		expect(windows.some((window) => window.binding)).toBe(false);
		expect(windows.every((window) => window.headroom < BINDING_HEADROOM_MIN)).toBe(true);
	});
});

describe("measureWholeSignalTruePeakDb — streaming whole-signal 4× TP (no materialization)", () => {
	async function bufferOf(channels: ReadonlyArray<Float32Array>): Promise<ChunkBuffer> {
		const buffer = new ChunkBuffer();

		await buffer.write(channels as Array<Float32Array>, SAMPLE_RATE, 32);
		await buffer.flushWrites();

		return buffer;
	}

	it("equals a reference single-fresh-accumulator measurement of the same samples to FP (mono)", async () => {
		const signal = makeHeadroomBearing(SAMPLE_RATE, SAMPLE_RATE);
		const buffer = await bufferOf([signal]);

		const streamed = await measureWholeSignalTruePeakDb(buffer, SAMPLE_RATE);

		await buffer.close();

		expect(streamed).toBeCloseTo(referenceTruePeakDb([signal]), 9);
	});

	it("equals the reference to FP on an already-limited signal (linked stereo)", async () => {
		const left = makePreClipped(SAMPLE_RATE, SAMPLE_RATE);
		const right = makeDense(SAMPLE_RATE, SAMPLE_RATE);
		const buffer = await bufferOf([left, right]);

		const streamed = await measureWholeSignalTruePeakDb(buffer, SAMPLE_RATE);

		await buffer.close();

		expect(streamed).toBeCloseTo(referenceTruePeakDb([left, right]), 9);
	});

	it("returns the linearToDb silence floor for an empty buffer", async () => {
		const buffer = new ChunkBuffer();

		await buffer.flushWrites();

		const streamed = await measureWholeSignalTruePeakDb(buffer, SAMPLE_RATE);

		await buffer.close();

		expect(streamed).toBe(linearToDb(0));
	});
});
