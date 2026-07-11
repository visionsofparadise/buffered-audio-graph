import { validateGraphDefinition } from "@buffered-audio/core";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { VALIDATE_GRAPH_DEFINITION_ACTION, type ValidateGraphDefinitionIpcParameters, type ValidateGraphDefinitionIpcReturn } from "./Renderer";

export class ValidateGraphDefinitionMainIpc extends AsyncMainIpc<ValidateGraphDefinitionIpcParameters, ValidateGraphDefinitionIpcReturn> {
	action = VALIDATE_GRAPH_DEFINITION_ACTION;

	handler(definition: unknown, _dependencies: IpcHandlerDependencies): ValidateGraphDefinitionIpcReturn {
		return validateGraphDefinition(definition);
	}
}
