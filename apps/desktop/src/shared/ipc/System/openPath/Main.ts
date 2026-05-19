import { shell } from "electron";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { OPEN_PATH_ACTION, type OpenPathIpcParameters, type OpenPathIpcReturn } from "./Renderer";

export class OpenPathMainIpc extends AsyncMainIpc<OpenPathIpcParameters, OpenPathIpcReturn> {
	action = OPEN_PATH_ACTION;

	async handler(targetPath: string, _dependencies: IpcHandlerDependencies): Promise<OpenPathIpcReturn> {
		return shell.openPath(targetPath);
	}
}
