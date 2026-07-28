import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type OpenPathIpcParameters = [targetPath: string];
export type OpenPathIpcReturn = string;
export const OPEN_PATH_ACTION = "openPath" as const;

export class OpenPathRendererIpc extends AsyncRendererIpc<
	typeof OPEN_PATH_ACTION,
	OpenPathIpcParameters,
	OpenPathIpcReturn
> {
	action = OPEN_PATH_ACTION;
}
