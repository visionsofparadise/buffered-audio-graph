export function findPeak(samples: Array<Float32Array>): number {
	let peak = 0;

	for (const channel of samples) {
		for (let index = 0; index < channel.length; index++) {
			const absolute = Math.abs(channel[index] ?? 0);

			if (Number.isFinite(absolute) && absolute > peak) peak = absolute;
		}
	}

	return peak;
}

export function resolveScale(peak: number, ceiling: number): number {
	const raw = peak === 0 ? 1 : ceiling / peak;

	return Number.isFinite(raw) ? raw : 1;
}
