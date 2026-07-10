/* eslint-disable @typescript-eslint/no-non-null-assertion -- worker index is bounded by thread count */
import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { applyNlmSmoothingRange, type NlmParams } from "@buffered-audio/utils";

export interface NlmWorkerPool {
	readonly mode: "worker" | "in-thread";
	run(mask: Float32Array, output: Float32Array, numFrames: number, numBins: number, options: NlmParams): Promise<void>;
	close(): Promise<void>;
}

function resolveThreadCount(): number {
	return Number(process.env.DEBLEED_NLM_THREADS) || Math.max(1, Math.min(os.availableParallelism() - 1, 8));
}

interface Stripe {
	readonly blockFrameStart: number;
	readonly blockFrameEnd: number;
}

function partition(numFrames: number, pasteBlockSize: number, threads: number): Array<Stripe> {
	const totalBlocks = Math.ceil(numFrames / pasteBlockSize);
	const blocksPerStripe = Math.floor(totalBlocks / threads);
	const stripes: Array<Stripe> = [];

	for (let stripeIndex = 0; stripeIndex < threads; stripeIndex++) {
		const blockStart = stripeIndex * blocksPerStripe;
		const blockEnd = stripeIndex === threads - 1 ? totalBlocks : (stripeIndex + 1) * blocksPerStripe;
		const blockFrameStart = blockStart * pasteBlockSize;
		const blockFrameEnd = Math.min(blockEnd * pasteBlockSize, numFrames);

		if (blockFrameStart < blockFrameEnd) stripes.push({ blockFrameStart, blockFrameEnd });
	}

	return stripes;
}

export function createNlmWorkerPool(
	threads: number = resolveThreadCount(),
	workerUrl: URL = new URL("./nlm-worker.js", import.meta.url),
): NlmWorkerPool {
	const useWorkers = threads > 1 && typeof SharedArrayBuffer !== "undefined" && existsSync(fileURLToPath(workerUrl));

	if (!useWorkers) {
		return {
			mode: "in-thread",
			run(mask, output, numFrames, numBins, options): Promise<void> {
				applyNlmSmoothingRange(mask, numFrames, numBins, options, output, 0, numFrames);

				return Promise.resolve();
			},
			close(): Promise<void> {
				return Promise.resolve();
			},
		};
	}

	const workers = Array.from({ length: threads }, () => new Worker(workerUrl));

	return {
		mode: "worker",
		async run(mask, output, numFrames, numBins, options): Promise<void> {
			// Workers wrap the whole SharedArrayBuffer from offset 0; a nonzero-offset view would silently read/write the wrong region in worker mode only.
			if (mask.byteOffset !== 0 || output.byteOffset !== 0) throw new Error("nlm worker pool: mask/output views must start at byteOffset 0");

			const stripes = partition(numFrames, options.pasteBlockSize, threads);
			const maskSab = mask.buffer;
			const outputSab = output.buffer;

			await Promise.all(
				stripes.map((stripe, index) => {
					const worker = workers[index]!;

					return new Promise<void>((resolve, reject) => {
						const onMessage = (): void => {
							worker.off("error", onError);
							resolve();
						};
						const onError = (error: Error): void => {
							worker.off("message", onMessage);
							reject(error);
						};

						worker.once("message", onMessage);
						worker.once("error", onError);
						worker.postMessage({
							maskSab,
							outputSab,
							numFrames,
							numBins,
							options,
							blockFrameStart: stripe.blockFrameStart,
							blockFrameEnd: stripe.blockFrameEnd,
						});
					});
				}),
			);
		},
		async close(): Promise<void> {
			await Promise.all(workers.map((worker) => worker.terminate()));
		},
	};
}
