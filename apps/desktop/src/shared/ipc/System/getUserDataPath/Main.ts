import { app } from "electron";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { GET_USER_DATA_PATH_ACTION, type GetUserDataPathIpcParameters, type GetUserDataPathIpcReturn } from "./Renderer";

export class GetUserDataPathMainIpc extends AsyncMainIpc<GetUserDataPathIpcParameters, GetUserDataPathIpcReturn> {
	action = GET_USER_DATA_PATH_ACTION;

	handler(_dependencies: IpcHandlerDependencies): GetUserDataPathIpcReturn {
		return app.getPath("userData");
	}
}
