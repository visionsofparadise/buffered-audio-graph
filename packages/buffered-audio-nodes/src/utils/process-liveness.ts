import pidtree from "pidtree";
import pidusage from "pidusage";

export interface ProcessLivenessSample {
	readonly elapsedMs: number;
	readonly cpuDeltaMs: number;
	readonly cpuMs: number;
	readonly state: "active" | "idle";
	readonly pidCount: number;
}

export interface ProcessLivenessOptions {
	readonly intervalMs?: number;
	readonly activeCpuThresholdMs?: number;
	readonly sampler?: (rootPid: number) => Promise<{ cpuMs: number; pidCount: number }>;
	readonly onError?: (error: unknown) => void;
}

export async function sampleProcessTreeCpu(rootPid: number): Promise<{ cpuMs: number; pidCount: number }> {
	const pids = await pidtree(rootPid, { root: true });

	try {
		const stats = await pidusage(pids);
		const liveStats = Object.values(stats);

		return {
			cpuMs: liveStats.reduce((total, stat) => total + stat.ctime, 0),
			pidCount: liveStats.length,
		};
	} catch {
		const stats = await Promise.all(pids.map(async (pid) => {
			try {
				return await pidusage(pid);
			} catch {
				return undefined;
			}
		}));
		const liveStats = stats.filter((stat) => stat !== undefined);

		return {
			cpuMs: liveStats.reduce((total, stat) => total + stat.ctime, 0),
			pidCount: liveStats.length,
		};
	}
}

export function startProcessLivenessMonitor(
	rootPid: number,
	onSample: (sample: ProcessLivenessSample) => void,
	options: ProcessLivenessOptions = {},
): () => Promise<void> {
	const intervalMs = options.intervalMs ?? 30_000;
	const activeCpuThresholdMs = options.activeCpuThresholdMs ?? 100;
	const sampler = options.sampler ?? sampleProcessTreeCpu;
	const startedAt = performance.now();
	let previousCpuMs: number | undefined;
	let stopped = false;
	let inFlightTick: Promise<void> | undefined;
	let inFlightError: unknown;
	const hasStopped = (): boolean => stopped;

	const tick = async (): Promise<void> => {
		if (hasStopped()) return;

		let sample: { cpuMs: number; pidCount: number };

		try {
			sample = await sampler(rootPid);
		} catch (error) {
			options.onError?.(error);

			return;
		}

		if (hasStopped()) return;
		if (previousCpuMs === undefined) {
			previousCpuMs = sample.cpuMs;

			return;
		}

		const cpuDeltaMs = Math.max(0, sample.cpuMs - previousCpuMs);

		previousCpuMs = sample.cpuMs;
		onSample({
			elapsedMs: Math.round(performance.now() - startedAt),
			cpuDeltaMs,
			cpuMs: sample.cpuMs,
			state: cpuDeltaMs >= activeCpuThresholdMs ? "active" : "idle",
			pidCount: sample.pidCount,
		});
	};
	const intervalHandle = setInterval(() => {
		if (inFlightTick !== undefined) return;

		const currentTick = tick();

		inFlightTick = currentTick;
		void currentTick.then(
			() => {
				if (inFlightTick === currentTick) inFlightTick = undefined;
			},
			(error: unknown) => {
				if (inFlightTick === currentTick) inFlightError = error;
			},
		);
	}, intervalMs);

	return async () => {
		stopped = true;
		clearInterval(intervalHandle);
		const currentTick = inFlightTick;

		if (currentTick === undefined) return;

		try {
			await currentTick;
		} catch {
			throw inFlightError;
		}
	};
}
