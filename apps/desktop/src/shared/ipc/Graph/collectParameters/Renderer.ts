import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";
import type { GraphDefinition } from "@buffered-audio/core";

export type CollectParametersIpcParameters = [definition: GraphDefinition];
export type CollectParametersIpcReturn = Array<string>;
export const COLLECT_PARAMETERS_ACTION = "collectParameters" as const;

export class CollectParametersRendererIpc extends AsyncRendererIpc<
	typeof COLLECT_PARAMETERS_ACTION,
	CollectParametersIpcParameters,
	CollectParametersIpcReturn
> {
	action = COLLECT_PARAMETERS_ACTION;
}
