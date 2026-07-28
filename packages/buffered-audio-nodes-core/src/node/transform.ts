import { appendChild, BufferedAudioNode, type BufferedAudioNodeProperties, type Composition } from ".";

export interface TransformNodeProperties extends BufferedAudioNodeProperties {}

export abstract class TransformNode<
	P extends TransformNodeProperties = TransformNodeProperties,
> extends BufferedAudioNode<P> {
	to(child: BufferedAudioNode | Composition): void {
		appendChild(this, child);
	}
}
