import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { UNWATCH_FILE_ACTION, type UnwatchFileIpcParameters, type UnwatchFileIpcReturn } from "./Renderer";

export class UnwatchFileMainIpc extends AsyncMainIpc<UnwatchFileIpcParameters, UnwatchFileIpcReturn> {
	action = UNWATCH_FILE_ACTION;

	handler(filePath: string, dependencies: IpcHandlerDependencies): UnwatchFileIpcReturn {
		dependencies.fileWatcherManager.unwatch(filePath);
	}
}
