type Direction = 1 | -1;

// eslint-disable-next-line comment-rules/no-restricted-comments
// Monotonic deque per Lemire, "Streaming Maximum-Minimum Filter Using No More than Three Comparisons per Element" (2006).
function slidingWindowExtreme(input: Float32Array, halfWidth: number, direction: Direction): Float32Array {
	const length = input.length;
	const output = new Float32Array(length);

	if (length === 0) return output;

	const deque = new Int32Array(length);
	const dequeValues = new Float32Array(length);
	let dequeHead = 0;
	let dequeTail = 0;
	let nextRight = 0;

	for (let outputIdx = 0; outputIdx < length; outputIdx++) {
		const rightEdge = Math.min(length - 1, outputIdx + halfWidth);
		const leftEdge = Math.max(0, outputIdx - halfWidth);

		while (nextRight <= rightEdge) {
			const orderedValue = (input[nextRight] ?? 0) * direction;

			while (dequeTail > dequeHead && (dequeValues[dequeTail - 1] ?? 0) <= orderedValue) {
				dequeTail--;
			}

			deque[dequeTail] = nextRight;
			dequeValues[dequeTail] = orderedValue;
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

class SlidingWindowExtremeStream {
	private readonly halfWidth: number;
	private readonly direction: Direction;
	private readonly lookAhead: Float32Array;
	private readonly deque: Int32Array;
	private dequeHead = 0;
	private dequeTail = 0;
	private consumedFrames = 0;
	private emittedFrames = 0;

	constructor(halfWidth: number, direction: Direction, callerName: string) {
		if (halfWidth < 0 || !Number.isFinite(halfWidth)) {
			throw new RangeError(`${callerName}: halfWidth must be a non-negative finite number, got ${halfWidth}`);
		}

		this.halfWidth = halfWidth;
		this.direction = direction;

		const ringCapacity = 2 * halfWidth + 1;

		this.lookAhead = new Float32Array(ringCapacity);
		this.deque = new Int32Array(ringCapacity);
	}

	push(chunk: Float32Array, isFinal: boolean): Float32Array {
		const chunkLength = chunk.length;
		const halfWidth = this.halfWidth;
		const direction = this.direction;
		const ringSize = this.lookAhead.length;
		const dequeCapacity = this.deque.length;
		const totalAfter = this.consumedFrames + chunkLength;
		const targetEmittedAfter = isFinal ? totalAfter : Math.max(0, totalAfter - halfWidth);
		const emitCount = Math.max(0, targetEmittedAfter - this.emittedFrames);
		const output = new Float32Array(emitCount);
		let outputCursor = 0;

		for (let chunkIdx = 0; chunkIdx < chunkLength; chunkIdx++) {
			const inputIdx = this.consumedFrames;
			const orderedValue = (chunk[chunkIdx] ?? 0) * direction;

			this.lookAhead[inputIdx % ringSize] = orderedValue;

			while (this.dequeTail > this.dequeHead) {
				const tailIdx = this.deque[(this.dequeTail - 1) % dequeCapacity] ?? 0;
				const tailValue = this.lookAhead[tailIdx % ringSize] ?? 0;

				if (tailValue > orderedValue) break;

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

			output[outputCursor] = (this.lookAhead[frontIdx % ringSize] ?? 0) * direction;
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

					output[outputCursor] = (this.lookAhead[frontIdx % ringSize] ?? 0) * direction;
				}

				outputCursor++;
				this.emittedFrames++;
			}
		}

		return output;
	}
}

export function slidingWindowMax(input: Float32Array, halfWidth: number): Float32Array {
	return slidingWindowExtreme(input, halfWidth, 1);
}

export function slidingWindowMin(input: Float32Array, halfWidth: number): Float32Array {
	return slidingWindowExtreme(input, halfWidth, -1);
}

export class SlidingWindowMaxStream {
	private readonly window: SlidingWindowExtremeStream;

	constructor(halfWidth: number) {
		this.window = new SlidingWindowExtremeStream(halfWidth, 1, "SlidingWindowMaxStream");
	}

	push(chunk: Float32Array, isFinal: boolean): Float32Array {
		return this.window.push(chunk, isFinal);
	}
}

export class SlidingWindowMinStream {
	private readonly window: SlidingWindowExtremeStream;

	constructor(halfWidth: number) {
		this.window = new SlidingWindowExtremeStream(halfWidth, -1, "SlidingWindowMinStream");
	}

	push(chunk: Float32Array, isFinal: boolean): Float32Array {
		return this.window.push(chunk, isFinal);
	}
}
