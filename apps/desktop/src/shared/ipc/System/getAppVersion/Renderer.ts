import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type GetAppVersionIpcParameters = [];
export type GetAppVersionIpcReturn = string;
export const GET_APP_VERSION_ACTION = "getAppVersion" as const;

export class GetAppVersionRendererIpc extends AsyncRendererIpc<
	typeof GET_APP_VERSION_ACTION,
	GetAppVersionIpcParameters,
	GetAppVersionIpcReturn
> {
	action = GET_APP_VERSION_ACTION;
}
