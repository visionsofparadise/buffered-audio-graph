import { RenderJob, type RenderOptions } from "../render-job";
import { BufferedAudioNode, type Composition } from ".";
import type { SourceNodeProperties } from "./stream/source";

export abstract class SourceNode<P extends SourceNodeProperties = SourceNodeProperties> extends BufferedAudioNode<P> {
	to(child: BufferedAudioNode | Composition): void {
		const head = "head" in child ? child.head : child;

		this.properties = { ...this.properties, children: [...(this.properties.children ?? []), head] } as P;
	}

	createRenderJob(options?: RenderOptions): RenderJob {
		return new RenderJob(this, options);
	}
}
