import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type GetWindowIdIpcParameters = [];
export type GetWindowIdIpcReturn = string;
export const GET_WINDOW_ID_ACTION = "getWindowId" as const;

export class GetWindowIdRendererIpc extends AsyncRendererIpc<typeof GET_WINDOW_ID_ACTION, GetWindowIdIpcParameters, GetWindowIdIpcReturn> {
	action = GET_WINDOW_ID_ACTION;
}
