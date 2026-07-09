import { BlockBuffer } from "./block-buffer";
import type { Block, BufferedAudioNode, StreamContext } from "./node";
import { createProgressGate } from "./progress-gate";
import { BufferedStream, type StreamRenderContext } from "./stream";
import type { TransformNodeProperties } from "./transform";

export const WHOLE_FILE = Infinity;

export interface BufferedTransformNodeProperties extends TransformNodeProperties {
	readonly blockSize?: number;
	readonly streamChunkSize?: number;
}

function iteratorOf(iterable: AsyncIterable<Block> | Iterable<Block>): AsyncIterator<Block> | Iterator<Block> {
	if (Symbol.asyncIterator in iterable) return iterable[Symbol.asyncIterator]();

	return iterable[Symbol.iterator]();
}

export abstract class BufferedTransformStream<
	N extends BufferedAudioNode<BufferedTransformNodeProperties> = BufferedAudioNode<BufferedTransformNodeProperties>,
> extends BufferedStream<N> {
	blockSize: number;

	private processingMs = 0;
	private framesBuffered = 0;
	private framesEmitted = 0;

	private buffer?: BlockBuffer;
	private inferredChunkSize?: number;
	private hasStarted = false;
	private sourceTotalFrames?: number;

	constructor(node: BufferedAudioNode, context: StreamRenderContext) {
		super(node, context);

		const blockSize = this.properties.blockSize ?? WHOLE_FILE;

		if (blockSize === 0) throw new Error("BufferedTransformStream: blockSize must be a positive integer or WHOLE_FILE, not 0");

		this.blockSize = blockSize;
	}

	protected get sampleRate(): number | undefined {
		return this.buffer?.sampleRate;
	}

	protected get bitDepth(): number | undefined {
		return this.buffer?.bitDepth;
	}

	private get outputChunkSize(): number {
		return this.streamChunkSize ?? this.inferredChunkSize ?? 44100;
	}

	protected get streamChunkSize(): number | undefined {
		return this.properties.streamChunkSize;
	}

	setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		this.sourceTotalFrames = context.durationFrames;

		return this.orchestrate(input, context);
	}

	private async orchestrate(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		await this._setup(context);

		return this._pipe(input);
	}

	_setup(_context: StreamContext): Promise<void> | void {
		return;
	}

	_pipe(input: ReadableStream<Block>): ReadableStream<Block> {
		const reader = input.getReader();
		const bufferGate = createProgressGate(this.sourceTotalFrames);
		const emitGate = createProgressGate(this.sourceTotalFrames);

		let pending: { block: Block; offset: number } | undefined;
		let iterator: AsyncIterator<Block> | Iterator<Block> | undefined;
		let servingFlush = false;
		let batchFrames = 0;
		let inputEnded = false;
		let flushDone = false;

		const serve = (controller: ReadableStreamDefaultController<Block>, block: Block): void => {
			const frames = block.samples[0]?.length ?? 0;
			const cap = this.outputChunkSize;

			if (frames > cap) {
				for (let start = 0; start < frames; start += cap) {
					const take = Math.min(cap, frames - start);

					controller.enqueue({
						samples: block.samples.map((channel) => channel.subarray(start, start + take)),
						offset: block.offset + start,
						sampleRate: block.sampleRate,
						bitDepth: block.bitDepth,
					});
				}
			} else {
				controller.enqueue(block);
			}

			this.framesEmitted += frames;
			if (emitGate(this.framesEmitted, Date.now())) this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
		};

		// Writes into the buffer from `current`, advancing its offset. WHOLE_FILE writes the whole block and
		// never signals a batch; block mode writes one blockSize-capped slice and returns true when the buffer
		// has filled to blockSize (a batch is ready to serve).
		const intake = async (current: { block: Block; offset: number }): Promise<boolean> => {
			const buffer = (this.buffer ??= new BlockBuffer());
			const blockFrames = current.block.samples[0]?.length ?? 0;
			const start = performance.now();

			if (this.blockSize === WHOLE_FILE) {
				const prepared = await this._prepare(current.block);

				await buffer.write(prepared.samples, prepared.sampleRate, prepared.bitDepth);
				current.offset = blockFrames;
				this.processingMs += performance.now() - start;
				this.framesBuffered += blockFrames;
				if (bufferGate(this.framesBuffered, Date.now())) this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);

				return false;
			}

			const space = this.blockSize - buffer.frames;
			const take = Math.min(space, blockFrames - current.offset);
			const sliced: Block = {
				samples: current.block.samples.map((channel) => channel.subarray(current.offset, current.offset + take)),
				offset: current.block.offset + current.offset,
				sampleRate: current.block.sampleRate,
				bitDepth: current.block.bitDepth,
			};
			const prepared = await this._prepare(sliced);

			await buffer.write(prepared.samples, prepared.sampleRate, prepared.bitDepth);
			current.offset += take;
			this.processingMs += performance.now() - start;
			this.framesBuffered += take;
			if (bufferGate(this.framesBuffered, Date.now())) this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);

			return buffer.frames >= this.blockSize;
		};

		const beginBatch = async (): Promise<void> => {
			const buffer = this.buffer;

			if (!buffer) return;

			await buffer.flushWrites();
			batchFrames = buffer.frames;
			servingFlush = false;
			if (this.blockSize === WHOLE_FILE) this.emitProgress("process", 0, batchFrames);
			iterator = this._transform(buffer)[Symbol.asyncIterator]();
		};

		return new ReadableStream<Block>({
			pull: async (controller) => {
				for (;;) {
					if (iterator) {
						const start = performance.now();
						const result = await iterator.next();

						this.processingMs += performance.now() - start;

						if (!result.done) {
							serve(controller, result.value);

							return;
						}

						iterator = undefined;

						if (!servingFlush) {
							if (this.blockSize === WHOLE_FILE) this.emitProgress("process", batchFrames, batchFrames);
							await this.buffer?.clear();
						}

						continue;
					}

					if (!inputEnded) {
						if (!pending) {
							const { value, done } = await reader.read();

							if (done) {
								inputEnded = true;

								continue;
							}

							if (!this.hasStarted) {
								this.hasStarted = true;
								this.emitStarted();
							}

							this.inferredChunkSize ??= value.samples[0]?.length ?? 0;
							pending = { block: value, offset: 0 };
						}

						const ready = await intake(pending);

						if (pending.offset >= (pending.block.samples[0]?.length ?? 0)) pending = undefined;
						if (ready) await beginBatch();

						continue;
					}

					if (this.buffer && this.buffer.frames > 0) {
						await beginBatch();

						continue;
					}

					if (!flushDone) {
						flushDone = true;
						servingFlush = true;
						iterator = iteratorOf(this._flush());

						continue;
					}

					this.emitProgress("buffer", this.framesBuffered, this.sourceTotalFrames);
					this.emitProgress("emit", this.framesEmitted, this.sourceTotalFrames);
					this.emitFinished({ framesDone: this.framesBuffered, processingMs: this.processingMs });
					controller.close();
					await this.destroy();

					return;
				}
			},
			cancel: async (reason) => {
				await iterator?.return?.();
				await reader.cancel(reason);
				await this.destroy();
			},
		});
	}

	override async destroy(): Promise<void> {
		try {
			await super.destroy();
		} finally {
			if (this.buffer) {
				await this.buffer.close();
				this.buffer = undefined;
			}
		}
	}

	_prepare(block: Block): Promise<Block> | Block {
		return block;
	}

	async *_transform(buffered: BlockBuffer): AsyncIterable<Block> {
		yield* buffered.iterate(this.outputChunkSize);
	}

	_flush(): AsyncIterable<Block> | Iterable<Block> {
		return [];
	}
}
