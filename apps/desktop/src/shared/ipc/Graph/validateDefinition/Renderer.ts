import type { GraphDefinition } from "@buffered-audio/core";
import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";

export type ValidateGraphDefinitionIpcParameters = [definition: unknown];
export type ValidateGraphDefinitionIpcReturn = GraphDefinition;
export const VALIDATE_GRAPH_DEFINITION_ACTION = "validateGraphDefinition" as const;

export class ValidateGraphDefinitionRendererIpc extends AsyncRendererIpc<typeof VALIDATE_GRAPH_DEFINITION_ACTION, ValidateGraphDefinitionIpcParameters, ValidateGraphDefinitionIpcReturn> {
	action = VALIDATE_GRAPH_DEFINITION_ACTION;
}
