export const PROGRESS_PERCENT_QUANTUM = 0.01;
export const PROGRESS_MIN_INTERVAL_MS = 10_000;

export type ProgressGate = (framesDone: number, now: number) => boolean;

export function createProgressGate(framesTotal?: number): ProgressGate {
	let lastBucket = -1;
	let lastEmitAt: number | undefined;

	return (framesDone, now) => {
		const bucket = framesTotal !== undefined ? Math.floor(framesDone / framesTotal / PROGRESS_PERCENT_QUANTUM) : undefined;
		const bucketAdvanced = bucket === undefined || bucket > lastBucket;
		const intervalPassed = lastEmitAt === undefined || now - lastEmitAt >= PROGRESS_MIN_INTERVAL_MS;

		if (!bucketAdvanced || !intervalPassed) return false;

		if (bucket !== undefined) lastBucket = bucket;
		lastEmitAt = now;

		return true;
	};
}
