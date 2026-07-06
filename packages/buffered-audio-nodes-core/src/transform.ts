import { BufferedAudioNode, type BufferedAudioNodeProperties, type Composition } from "./node";

export interface TransformNodeProperties extends BufferedAudioNodeProperties {
	readonly streamChunkSize?: number;
}

export abstract class TransformNode<P extends TransformNodeProperties = TransformNodeProperties> extends BufferedAudioNode<P> {
	static override is(value: unknown): value is TransformNode {
		return BufferedAudioNode.is(value) && value.type[1] === "transform";
	}

	to(child: BufferedAudioNode | Composition): void {
		const head = "head" in child ? child.head : child;

		this.properties = { ...this.properties, children: [...(this.properties.children ?? []), head] } as P;
	}
}
