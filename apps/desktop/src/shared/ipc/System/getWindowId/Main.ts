import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { GET_WINDOW_ID_ACTION, type GetWindowIdIpcParameters, type GetWindowIdIpcReturn } from "./Renderer";

export class GetWindowIdMainIpc extends AsyncMainIpc<GetWindowIdIpcParameters, GetWindowIdIpcReturn> {
	action = GET_WINDOW_ID_ACTION;

	handler(dependencies: IpcHandlerDependencies): GetWindowIdIpcReturn {
		return dependencies.windowId;
	}
}
