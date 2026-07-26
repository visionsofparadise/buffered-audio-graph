import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type QuitAppIpcParameters = [];
export type QuitAppIpcReturn = undefined;
export const QUIT_APP_ACTION = "quitApp" as const;

export class QuitAppRendererIpc extends AsyncRendererIpc<typeof QUIT_APP_ACTION, QuitAppIpcParameters, QuitAppIpcReturn> {
	action = QUIT_APP_ACTION;
}
