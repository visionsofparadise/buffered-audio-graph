import { peakPriorityAmount } from "./lattice";
import { measureFrameTruePeakDb } from "./objective";

export const BINDING_DELTA_DB = 3;

export const BINDING_HEADROOM_MIN = 0.5;

export interface WindowBinding {
	readonly binding: boolean;
	readonly peakIndex: number;
	readonly peakValue: number;
	readonly peakMagnitude: number;
	readonly headroom: number;
	readonly frameTruePeakDb: number;
}

export function classifyWindow(
	channelWindows: ReadonlyArray<Float32Array>,
	globalTruePeakDb: number,
	sampleRate: number,
	isGlobalTpFrame = false,
): WindowBinding {
	const length = channelWindows[0]?.length ?? 0;
	const channelCount = channelWindows.length;

	if (length === 0 || channelCount === 0)
		return {
			binding: false,
			peakIndex: -1,
			peakValue: 0,
			peakMagnitude: 0,
			headroom: 0,
			frameTruePeakDb: measureFrameTruePeakDb([], sampleRate),
		};

	const sumWindow = new Float32Array(length);

	for (const channelWindow of channelWindows) {
		const limit = Math.min(length, channelWindow.length);

		for (let position = 0; position < limit; position++)
			sumWindow[position] = Math.fround((sumWindow[position] ?? 0) + (channelWindow[position] ?? 0));
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

export function isBindingPeak(
	frameTruePeakDb: number,
	headroom: number,
	globalTruePeakDb: number,
	isGlobalTpFrame = false,
): boolean {
	const proximate = frameTruePeakDb >= globalTruePeakDb - BINDING_DELTA_DB;

	return headroom > BINDING_HEADROOM_MIN && (proximate || isGlobalTpFrame);
}
