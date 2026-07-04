const computeRingSize = (blockSize: number, blockStep: number): number => Math.max(1, Math.ceil(blockSize / blockStep));

export class BlockSumAccumulator {
	private readonly blockSize: number;
	private readonly blockStep: number;
	private readonly ringSize: number;

	private readonly activeBlockSums: Float64Array;

	private readonly closedBlockSums: Array<number> = [];

	private samplesProcessed = 0;
	private nextBlockToOpen = 0;
	private nextBlockToClose = 0;
	private finalized = false;

	constructor(blockSize: number, blockStep: number) {
		if (blockSize <= 0) {
			throw new Error(`BlockSumAccumulator: blockSize must be positive, got ${blockSize}`);
		}

		if (blockStep <= 0) {
			throw new Error(`BlockSumAccumulator: blockStep must be positive, got ${blockStep}`);
		}

		this.blockSize = blockSize;
		this.blockStep = blockStep;
		this.ringSize = computeRingSize(blockSize, blockStep);
		this.activeBlockSums = new Float64Array(this.ringSize);
	}

	// Consumes `frames` per-frame sums from `perFrameSums[0]` (needs length >= `frames`); block-boundary accounting advances as if appended to one contiguous stream.
	push(perFrameSums: Float64Array, frames: number): void {
		if (this.finalized) {
			throw new Error("BlockSumAccumulator: push() called after finalize()");
		}

		if (frames <= 0) return;

		if (perFrameSums.length < frames) {
			throw new Error(`BlockSumAccumulator: perFrameSums has ${perFrameSums.length} entries, fewer than the requested ${frames}`);
		}

		const blockSize = this.blockSize;
		const blockStep = this.blockStep;
		const ringSize = this.ringSize;
		const activeBlockSums = this.activeBlockSums;

		for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
			const globalSampleIndex = this.samplesProcessed;
			const sampleContribution = perFrameSums[frameIndex] ?? 0;

			const rawMinBlock = Math.ceil((globalSampleIndex - blockSize + 1) / blockStep);
			const minBlock = rawMinBlock < 0 ? 0 : rawMinBlock;
			const maxBlock = Math.floor(globalSampleIndex / blockStep);

			while (this.nextBlockToOpen <= maxBlock) {
				activeBlockSums[this.nextBlockToOpen % ringSize] = 0;
				this.nextBlockToOpen++;
			}

			for (let blockIndex = minBlock; blockIndex <= maxBlock; blockIndex++) {
				const slot = blockIndex % ringSize;

				activeBlockSums[slot] = (activeBlockSums[slot] ?? 0) + sampleContribution;
			}

			this.samplesProcessed = globalSampleIndex + 1;

			while (this.samplesProcessed >= this.nextBlockToClose * blockStep + blockSize) {
				const closingIndex = this.nextBlockToClose;
				const slot = closingIndex % ringSize;

				this.closedBlockSums.push(activeBlockSums[slot] ?? 0);
				this.nextBlockToClose++;
			}
		}
	}

	finalize(): Array<number> {
		this.finalized = true;

		return this.closedBlockSums;
	}
}
