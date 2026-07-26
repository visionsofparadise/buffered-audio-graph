import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { WATCH_FILE_ACTION, type WatchFileIpcParameters, type WatchFileIpcReturn } from "./Renderer";

export class WatchFileMainIpc extends AsyncMainIpc<WatchFileIpcParameters, WatchFileIpcReturn> {
	action = WATCH_FILE_ACTION;

	handler(filePath: string, dependencies: IpcHandlerDependencies): WatchFileIpcReturn {
		dependencies.fileWatcherManager.watch(filePath);
	}
}
