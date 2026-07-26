import { app } from "electron";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { GET_APP_VERSION_ACTION, type GetAppVersionIpcParameters, type GetAppVersionIpcReturn } from "./Renderer";

export class GetAppVersionMainIpc extends AsyncMainIpc<GetAppVersionIpcParameters, GetAppVersionIpcReturn> {
	action = GET_APP_VERSION_ACTION;

	handler(_dependencies: IpcHandlerDependencies): GetAppVersionIpcReturn {
		return app.getVersion();
	}
}
