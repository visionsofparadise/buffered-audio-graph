import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type WatchFileIpcParameters = [filePath: string];
export type WatchFileIpcReturn = undefined;
export const WATCH_FILE_ACTION = "watchFile" as const;

export class WatchFileRendererIpc extends AsyncRendererIpc<typeof WATCH_FILE_ACTION, WatchFileIpcParameters, WatchFileIpcReturn> {
	action = WATCH_FILE_ACTION;
}
