import { collectParameters } from "@buffered-audio/core";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { COLLECT_PARAMETERS_ACTION, type CollectParametersIpcParameters, type CollectParametersIpcReturn } from "./Renderer";

export class CollectParametersMainIpc extends AsyncMainIpc<CollectParametersIpcParameters, CollectParametersIpcReturn> {
	action = COLLECT_PARAMETERS_ACTION;

	handler(definition: CollectParametersIpcParameters[0], _dependencies: IpcHandlerDependencies): CollectParametersIpcReturn {
		return collectParameters(definition);
	}
}
