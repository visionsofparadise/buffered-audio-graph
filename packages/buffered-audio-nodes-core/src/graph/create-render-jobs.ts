import type { RenderJob, RenderOptions } from "../render-job";
import type { GraphDefinition, NodeRegistry } from "./definition";
import { substituteParameters } from "./substitute-parameters";
import { unpack } from "./unpack";

export interface RenderGraphOptions extends RenderOptions {
	parameters?: Record<string, string>;
}

export function createRenderJobs(definition: GraphDefinition, registry: NodeRegistry, options?: RenderGraphOptions): Array<RenderJob> {
	const substituted = substituteParameters(definition, options?.parameters ?? {});
	const sources = unpack(substituted, registry);

	const { parameters: _parameters, ...renderOptions } = options ?? {};

	return sources.map((source) => source.createRenderJob(renderOptions));
}
