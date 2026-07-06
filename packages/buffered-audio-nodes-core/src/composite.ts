import type { BufferedAudioNode, Block, RenderOptions, StreamContext } from "./node";
import { SourceNode } from "./source";
import { TransformNode } from "./transform";

export abstract class CompositeNode extends TransformNode {
	abstract get head(): BufferedAudioNode;
	abstract get tail(): BufferedAudioNode;

	override to(child: BufferedAudioNode): void {
		if (!SourceNode.is(this.tail) && !TransformNode.is(this.tail)) {
			throw new Error("Cannot connect downstream from a target node; this composite is a complete pipeline");
		}

		(this.tail).to(child);
	}

	override get children(): ReadonlyArray<BufferedAudioNode> {
		return [this.head];
	}

	override async setup(readable: ReadableStream<Block>, context: StreamContext): Promise<Array<Promise<void>>> {
		if (!TransformNode.is(this.head)) {
			throw new Error("Cannot setup a composite whose head is a source node; use render() for complete pipelines");
		}

		return this.head.setup(readable, context);
	}

	async render(options?: RenderOptions): Promise<void> {
		if (!SourceNode.is(this.head)) {
			throw new Error("Cannot render a composite whose head is not a source node");
		}

		return this.head.render(options);
	}
}
