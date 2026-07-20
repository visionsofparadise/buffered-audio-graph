import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcessLivenessMonitor } from "./process-liveness";

const INTERVAL_MS = 1_000;
const ROOT_PID = 42;

afterEach(() => {
	vi.useRealTimers();
});

describe("startProcessLivenessMonitor", () => {
	it("primes a baseline and classifies clamped cumulative CPU deltas", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		const samples = [
			{ cpuMs: 100, pidCount: 1 },
			{ cpuMs: 200, pidCount: 2 },
			{ cpuMs: 299, pidCount: 2 },
			{ cpuMs: 250, pidCount: 1 },
		];
		const sampler = vi.fn(async () => {
			const sample = samples.shift();

			if (sample === undefined) throw new Error("No scripted sample");

			return sample;
		});
		const onSample = vi.fn();
		const stop = startProcessLivenessMonitor(ROOT_PID, onSample, {
			intervalMs: INTERVAL_MS,
			activeCpuThresholdMs: 100,
			sampler,
		});

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(onSample).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(onSample).toHaveBeenLastCalledWith({
			elapsedMs: 2_000,
			cpuDeltaMs: 100,
			cpuMs: 200,
			state: "active",
			pidCount: 2,
		});

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(onSample).toHaveBeenLastCalledWith({
			elapsedMs: 3_000,
			cpuDeltaMs: 99,
			cpuMs: 299,
			state: "idle",
			pidCount: 2,
		});

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(onSample).toHaveBeenLastCalledWith({
			elapsedMs: 4_000,
			cpuDeltaMs: 0,
			cpuMs: 250,
			state: "idle",
			pidCount: 1,
		});
		expect(sampler).toHaveBeenCalledTimes(4);
		expect(sampler).toHaveBeenCalledWith(ROOT_PID);

		await stop();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(onSample).toHaveBeenCalledTimes(3);
	});

	it("awaits an in-flight sample and suppresses its emission after stop", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		let resolveSample: ((sample: { cpuMs: number; pidCount: number }) => void) | undefined;
		let sampleCount = 0;
		const sampler = vi.fn(async () => {
			sampleCount += 1;
			if (sampleCount === 1) return { cpuMs: 100, pidCount: 1 };

			return new Promise<{ cpuMs: number; pidCount: number }>((resolve) => {
				resolveSample = resolve;
			});
		});
		const onSample = vi.fn();
		const stop = startProcessLivenessMonitor(ROOT_PID, onSample, {
			intervalMs: INTERVAL_MS,
			activeCpuThresholdMs: 100,
			sampler,
		});

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		vi.advanceTimersByTime(INTERVAL_MS);
		expect(sampler).toHaveBeenCalledTimes(2);

		let stopResolved = false;
		const stopPromise = stop().then(() => {
			stopResolved = true;
		});

		await Promise.resolve();
		expect(stopResolved).toBe(false);

		resolveSample?.({ cpuMs: 300, pidCount: 2 });
		await stopPromise;

		expect(stopResolved).toBe(true);
		expect(onSample).not.toHaveBeenCalled();
	});

	it("reports an in-flight sampler rejection and resolves stop", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		let rejectSample: ((error: Error) => void) | undefined;
		let sampleCount = 0;
		const sampler = vi.fn(async () => {
			sampleCount += 1;
			if (sampleCount === 1) return { cpuMs: 100, pidCount: 1 };

			return new Promise<{ cpuMs: number; pidCount: number }>((_resolve, reject) => {
				rejectSample = reject;
			});
		});
		const onSample = vi.fn();
		const onError = vi.fn();
		const stop = startProcessLivenessMonitor(ROOT_PID, onSample, {
			intervalMs: INTERVAL_MS,
			sampler,
			onError,
		});

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		vi.advanceTimersByTime(INTERVAL_MS);
		expect(sampler).toHaveBeenCalledTimes(2);

		const stopPromise = stop();
		const sampleError = new Error("Process exited during sampling");

		rejectSample?.(sampleError);

		await expect(stopPromise).resolves.toBeUndefined();
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith(sampleError);
		expect(onSample).not.toHaveBeenCalled();
	});

	it("surfaces an onSample exception through stop", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		const samples = [
			{ cpuMs: 100, pidCount: 1 },
			{ cpuMs: 200, pidCount: 1 },
		];
		const sampler = vi.fn(async () => {
			const sample = samples.shift();

			if (sample === undefined) throw new Error("No scripted sample");

			return sample;
		});
		const sampleError = new Error("Sample consumer failed");
		const onSample = vi.fn(() => {
			throw sampleError;
		});
		const onError = vi.fn();
		const stop = startProcessLivenessMonitor(ROOT_PID, onSample, {
			intervalMs: INTERVAL_MS,
			sampler,
			onError,
		});

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		vi.advanceTimersByTime(INTERVAL_MS);
		await Promise.resolve();

		await expect(stop()).rejects.toBe(sampleError);
		expect(onError).not.toHaveBeenCalled();
	});
});
