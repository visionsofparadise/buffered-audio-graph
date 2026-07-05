import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";

export interface RenderNodeInput {
	jobId: string;
	nodeId: string;
	packageName: string;
	packageVersion: string;
	nodeName: string;
	parameters: Record<string, unknown>;
	bypass: boolean;
	isSourceNode: boolean;
	inputPath: string;
	outputPath: string;
}

export type RenderNodeIpcParameters = [input: RenderNodeInput];
export type RenderNodeIpcReturn = undefined;
export const RENDER_NODE_ACTION = "audioRenderNode" as const;

export class RenderNodeRendererIpc extends AsyncRendererIpc<typeof RENDER_NODE_ACTION, RenderNodeIpcParameters, RenderNodeIpcReturn> {
	action = RENDER_NODE_ACTION;
}
