import { BufferedAudioNode, type BufferedAudioNodeProperties, type Composition } from "../..";

export interface TransformNodeProperties extends BufferedAudioNodeProperties {}

export abstract class TransformNode<P extends TransformNodeProperties = TransformNodeProperties> extends BufferedAudioNode<P> {
	to(child: BufferedAudioNode | Composition): void {
		const head = "head" in child ? child.head : child;

		this.properties = { ...this.properties, children: [...(this.properties.children ?? []), head] } as P;
	}
}
