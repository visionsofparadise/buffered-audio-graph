import { BufferedAudioNode, wireStream, type Block, type BufferedAudioNodeProperties, type StreamContext } from "./node";
import { BufferedStream } from "./stream";

export interface TargetNodeProperties extends BufferedAudioNodeProperties {}

export abstract class BufferedTargetStream<P extends TargetNodeProperties = TargetNodeProperties> extends BufferedStream<P> {
	private hasStarted = false;
	private framesWritten = 0;
	private sourceTotalFrames?: number;

	abstract _write(chunk: Block): Promise<void>;
	abstract _close(): Promise<void>;

	setup(readable: ReadableStream<Block>, context: StreamContext): Promise<void> {
		this.sourceTotalFrames = context.durationFrames;

		return this._setup(readable, context);
	}

	async _setup(input: ReadableStream<Block>, _context: StreamContext): Promise<void> {
		return input.pipeTo(this.createWritableStream());
	}

	private createWritableStream(): WritableStream<Block> {
		this.hasStarted = false;
		this.framesWritten = 0;

		return new WritableStream<Block>({
			write: async (chunk) => {
				if (!this.hasStarted) {
					this.hasStarted = true;
					this.events.emit("started");
				}

				await this._write(chunk);

				this.framesWritten += chunk.samples[0]?.length ?? 0;

				this.emitProgress("write", this.framesWritten, this.sourceTotalFrames);
			},
			close: async () => {
				await this._close();

				this.emitProgress("write", this.framesWritten, this.sourceTotalFrames, { force: true });
				this.events.emit("finished", { framesDone: this.framesWritten });
				await this.destroy();
			},
			abort: async () => {
				await this.destroy();
			},
		});
	}
}

export abstract class TargetNode<P extends TargetNodeProperties = TargetNodeProperties> extends BufferedAudioNode<P> {
	static override is(value: unknown): value is TargetNode {
		return BufferedAudioNode.is(value) && value.type[1] === "target";
	}

	abstract createStream(): BufferedTargetStream<P>;

	setup(readable: ReadableStream<Block>, context: StreamContext): Promise<Array<Promise<void>>> {
		const stream = this.createStream();

		this.streams.push(stream);

		wireStream(this, stream, context);

		return Promise.resolve([stream.setup(readable, context)]);
	}
}
