import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type GetUserDataPathIpcParameters = [];
export type GetUserDataPathIpcReturn = string;
export const GET_USER_DATA_PATH_ACTION = "getUserDataPath" as const;

export class GetUserDataPathRendererIpc extends AsyncRendererIpc<typeof GET_USER_DATA_PATH_ACTION, GetUserDataPathIpcParameters, GetUserDataPathIpcReturn> {
	action = GET_USER_DATA_PATH_ACTION;
}
