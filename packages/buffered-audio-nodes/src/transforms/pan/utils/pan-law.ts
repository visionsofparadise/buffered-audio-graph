export function panGains(pan: number): { leftGain: number; rightGain: number } {
	const theta = ((pan + 1) / 2) * (Math.PI / 2);

	return { leftGain: Math.cos(theta), rightGain: Math.sin(theta) };
}

export function balanceScales(pan: number): { leftScale: number; rightScale: number } {
	return { leftScale: Math.min(1, 1 - pan), rightScale: Math.min(1, 1 + pan) };
}
