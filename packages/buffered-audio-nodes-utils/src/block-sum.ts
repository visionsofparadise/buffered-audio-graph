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

		// Open blocks are exactly [nextBlockToClose, nextBlockToOpen); each counter advances only at its next sample boundary.
		let samplesProcessed = this.samplesProcessed;
		let nextBlockToOpen = this.nextBlockToOpen;
		let nextBlockToClose = this.nextBlockToClose;
		let nextOpenAt = nextBlockToOpen * blockStep;
		let nextCloseAt = nextBlockToClose * blockStep + blockSize;

		for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
			const sampleContribution = perFrameSums[frameIndex] ?? 0;

			while (samplesProcessed >= nextOpenAt) {
				activeBlockSums[nextBlockToOpen % ringSize] = 0;
				nextBlockToOpen++;
				nextOpenAt += blockStep;
			}

			let slot = nextBlockToClose % ringSize;

			for (let blockIndex = nextBlockToClose; blockIndex < nextBlockToOpen; blockIndex++) {
				activeBlockSums[slot] = (activeBlockSums[slot] ?? 0) + sampleContribution;
				slot++;

				if (slot === ringSize) slot = 0;
			}

			samplesProcessed++;

			while (samplesProcessed >= nextCloseAt) {
				this.closedBlockSums.push(activeBlockSums[nextBlockToClose % ringSize] ?? 0);
				nextBlockToClose++;
				nextCloseAt += blockStep;
			}
		}

		this.samplesProcessed = samplesProcessed;
		this.nextBlockToOpen = nextBlockToOpen;
		this.nextBlockToClose = nextBlockToClose;
	}

	finalize(): Array<number> {
		this.finalized = true;

		return this.closedBlockSums;
	}
}
