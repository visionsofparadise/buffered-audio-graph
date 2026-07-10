export function resolveLoudnessGain(integrated: number, target: number): number {
	return Number.isFinite(integrated) ? Math.pow(10, (target - integrated) / 20) : 1;
}
