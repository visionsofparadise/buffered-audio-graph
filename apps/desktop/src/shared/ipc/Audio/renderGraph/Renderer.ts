import type { GraphDefinition } from "@buffered-audio/core";
import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";

export interface RenderGraphInput {
	jobId: string;
	definition: GraphDefinition;
	/** Template parameter bindings forwarded to `createRenderJobs` for substitution. */
	parameters?: Record<string, string>;
}

export type RenderGraphIpcParameters = [input: RenderGraphInput];
export type RenderGraphIpcReturn = undefined;
export const RENDER_GRAPH_ACTION = "audioRenderGraph" as const;

export class RenderGraphRendererIpc extends AsyncRendererIpc<typeof RENDER_GRAPH_ACTION, RenderGraphIpcParameters, RenderGraphIpcReturn> {
	action = RENDER_GRAPH_ACTION;
}
