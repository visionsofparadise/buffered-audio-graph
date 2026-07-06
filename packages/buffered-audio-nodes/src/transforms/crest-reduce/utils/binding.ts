import type { BlockBuffer } from "@buffered-audio/core";
import { peakPriorityAmount } from "./lattice";
import { measureFrameTruePeakDb } from "./objective";
import { measureBufferTruePeakDb } from "./windowed";

// 3 dB binding proximity band (QA-tuned, not exposed) — see design-crest-reduce §Internal calibration.
export const BINDING_DELTA_DB = 3;

// min phase-only crest headroom to bind (QA-tuned 0.5) — see design-crest-reduce §Internal calibration.
export const BINDING_HEADROOM_MIN = 0.5;

export interface WindowBinding {
	readonly binding: boolean;
	readonly peakIndex: number;
	readonly peakValue: number;
	readonly peakMagnitude: number;
	readonly headroom: number;
	readonly frameTruePeakDb: number;
}

// The gate's single global TP measurement; composes the one streaming-measure impl (no resident whole-signal array).
export async function measureWholeSignalTruePeakDb(buffer: BlockBuffer, sampleRate: number): Promise<number> {
	return measureBufferTruePeakDb(buffer, sampleRate);
}

export function classifyWindow(channelWindows: ReadonlyArray<Float32Array>, globalTruePeakDb: number, sampleRate: number, isGlobalTpFrame = false): WindowBinding {
	const length = channelWindows[0]?.length ?? 0;
	const channelCount = channelWindows.length;

	if (length === 0 || channelCount === 0) return { binding: false, peakIndex: -1, peakValue: 0, peakMagnitude: 0, headroom: 0, frameTruePeakDb: measureFrameTruePeakDb([], sampleRate) };

	const sumWindow = new Float32Array(length);

	for (const channelWindow of channelWindows) {
		const limit = Math.min(length, channelWindow.length);

		for (let position = 0; position < limit; position++) sumWindow[position] = Math.fround((sumWindow[position] ?? 0) + (channelWindow[position] ?? 0));
	}

	let peakMagnitude = 0;
	let peakIndex = 0;
	let peakValue = 0;

	for (let position = 0; position < length; position++) {
		const value = sumWindow[position] ?? 0;
		const magnitude = value < 0 ? -value : value;

		if (magnitude > peakMagnitude) {
			peakMagnitude = magnitude;
			peakIndex = position;
			peakValue = value;
		}
	}

	const headroom = peakPriorityAmount(sumWindow, 0, length);

	const frameTruePeakDb = measureFrameTruePeakDb(channelWindows, sampleRate);
	const binding = isBindingPeak(frameTruePeakDb, headroom, globalTruePeakDb, isGlobalTpFrame);

	return { binding, peakIndex, peakValue, peakMagnitude, headroom, frameTruePeakDb };
}

export function isBindingPeak(frameTruePeakDb: number, headroom: number, globalTruePeakDb: number, isGlobalTpFrame = false): boolean {
	// The measureFrameTruePeakDb silence floor (−200 dB) can never be within BINDING_DELTA_DB of a real
	// peak, so silent windows are correctly non-binding.
	const proximate = frameTruePeakDb >= globalTruePeakDb - BINDING_DELTA_DB;

	return headroom > BINDING_HEADROOM_MIN && (proximate || isGlobalTpFrame);
}
