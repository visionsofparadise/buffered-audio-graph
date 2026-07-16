// Monotonic deque per Lemire, "Streaming Maximum-Minimum Filter Using No More than Three Comparisons per Element" (2006).
export function slidingWindowMin(input: Float32Array, halfWidth: number): Float32Array {
	const length = input.length;
	const output = new Float32Array(length);

	if (length === 0) return output;

	const deque = new Int32Array(length);
	let dequeHead = 0;
	let dequeTail = 0;
	let nextRight = 0;

	for (let outputIdx = 0; outputIdx < length; outputIdx++) {
		const rightEdge = Math.min(length - 1, outputIdx + halfWidth);
		const leftEdge = Math.max(0, outputIdx - halfWidth);

		while (nextRight <= rightEdge) {
			const value = input[nextRight] ?? 0;

			while (dequeTail > dequeHead && (input[deque[dequeTail - 1] ?? 0] ?? 0) >= value) {
				dequeTail--;
			}

			deque[dequeTail] = nextRight;
			dequeTail++;
			nextRight++;
		}

		while (dequeTail > dequeHead && (deque[dequeHead] ?? 0) < leftEdge) {
			dequeHead++;
		}

		output[outputIdx] = input[deque[dequeHead] ?? 0] ?? 0;
	}

	return output;
}

export class SlidingWindowMinStream {
	private readonly halfWidth: number;
	private readonly lookAhead: Float32Array;
	private readonly deque: Int32Array;
	private dequeHead = 0;
	private dequeTail = 0;
	private consumedFrames = 0;
	private emittedFrames = 0;

	constructor(halfWidth: number) {
		if (halfWidth < 0 || !Number.isFinite(halfWidth)) {
			throw new RangeError(`SlidingWindowMinStream: halfWidth must be a non-negative finite number, got ${halfWidth}`);
		}

		this.halfWidth = halfWidth;
		const ringCapacity = 2 * halfWidth + 1;

		this.lookAhead = new Float32Array(ringCapacity);
		this.deque = new Int32Array(ringCapacity);
	}

	push(chunk: Float32Array, isFinal: boolean): Float32Array {
		const chunkLength = chunk.length;
		const halfWidth = this.halfWidth;
		const ringSize = this.lookAhead.length;
		const dequeCapacity = this.deque.length;
		const totalAfter = this.consumedFrames + chunkLength;
		const targetEmittedAfter = isFinal ? totalAfter : Math.max(0, totalAfter - halfWidth);
		const emitCount = Math.max(0, targetEmittedAfter - this.emittedFrames);
		const output = new Float32Array(emitCount);
		let outputCursor = 0;

		for (let chunkIdx = 0; chunkIdx < chunkLength; chunkIdx++) {
			const inputIdx = this.consumedFrames;
			const value = chunk[chunkIdx] ?? 0;

			this.lookAhead[inputIdx % ringSize] = value;

			while (this.dequeTail > this.dequeHead) {
				const tailIdx = this.deque[(this.dequeTail - 1) % dequeCapacity] ?? 0;
				const tailValue = this.lookAhead[tailIdx % ringSize] ?? 0;

				if (tailValue < value) break;

				this.dequeTail--;
			}

			this.deque[this.dequeTail % dequeCapacity] = inputIdx;
			this.dequeTail++;
			this.consumedFrames++;

			const outputIdx = inputIdx - halfWidth;

			if (outputIdx < 0) continue;

			const leftEdge = Math.max(0, outputIdx - halfWidth);

			while (this.dequeTail > this.dequeHead && (this.deque[this.dequeHead % dequeCapacity] ?? 0) < leftEdge) {
				this.dequeHead++;
			}

			const frontIdx = this.deque[this.dequeHead % dequeCapacity] ?? 0;

			output[outputCursor] = this.lookAhead[frontIdx % ringSize] ?? 0;
			outputCursor++;
			this.emittedFrames++;
		}

		if (isFinal) {
			const finalLength = this.consumedFrames;

			while (this.emittedFrames < finalLength) {
				const outputIdx = this.emittedFrames;
				const leftEdge = Math.max(0, outputIdx - halfWidth);

				while (this.dequeTail > this.dequeHead && (this.deque[this.dequeHead % dequeCapacity] ?? 0) < leftEdge) {
					this.dequeHead++;
				}

				if (this.dequeTail === this.dequeHead) {
					output[outputCursor] = 0;
				} else {
					const frontIdx = this.deque[this.dequeHead % dequeCapacity] ?? 0;

					output[outputCursor] = this.lookAhead[frontIdx % ringSize] ?? 0;
				}

				outputCursor++;
				this.emittedFrames++;
			}
		}

		return output;
	}
}
