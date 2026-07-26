import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type UnwatchFileIpcParameters = [filePath: string];
export type UnwatchFileIpcReturn = undefined;
export const UNWATCH_FILE_ACTION = "unwatchFile" as const;

export class UnwatchFileRendererIpc extends AsyncRendererIpc<typeof UNWATCH_FILE_ACTION, UnwatchFileIpcParameters, UnwatchFileIpcReturn> {
	action = UNWATCH_FILE_ACTION;
}
