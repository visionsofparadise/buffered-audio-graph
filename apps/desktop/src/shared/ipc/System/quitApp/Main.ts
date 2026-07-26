import { app } from "electron";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { QUIT_APP_ACTION, type QuitAppIpcParameters, type QuitAppIpcReturn } from "./Renderer";

export class QuitAppMainIpc extends AsyncMainIpc<QuitAppIpcParameters, QuitAppIpcReturn> {
	action = QUIT_APP_ACTION;

	handler(_dependencies: IpcHandlerDependencies): QuitAppIpcReturn {
		app.quit();

		return undefined;
	}
}
