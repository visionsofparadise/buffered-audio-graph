import type { GraphDefinition } from "@buffered-audio/core";
import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";

export interface RenderGraphInput {
	bagId: string;
	graphDefinition: GraphDefinition;
	snapshotsDir: string;
}

export type RenderGraphIpcParameters = [input: RenderGraphInput];
export interface RenderGraphIpcReturn { jobId: string }
export const RENDER_GRAPH_ACTION = "audioRenderGraph" as const;

export class RenderGraphRendererIpc extends AsyncRendererIpc<typeof RENDER_GRAPH_ACTION, RenderGraphIpcParameters, RenderGraphIpcReturn> {
	action = RENDER_GRAPH_ACTION;
}
