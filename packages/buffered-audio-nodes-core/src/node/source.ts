import { RenderJob, type RenderOptions } from "../render-job";
import { appendChild, BufferedAudioNode, type Composition } from ".";
import type { SourceNodeProperties } from "./stream/source";

export abstract class SourceNode<P extends SourceNodeProperties = SourceNodeProperties> extends BufferedAudioNode<P> {
	to(child: BufferedAudioNode | Composition): void {
		appendChild(this, child);
	}

	createRenderJob(options?: RenderOptions): RenderJob {
		return new RenderJob(this, options);
	}
}
