import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

interface DisplayWorkArea {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export type GetAllDisplaysIpcParameters = [];
export type GetAllDisplaysIpcReturn = Array<DisplayWorkArea>;
export const GET_ALL_DISPLAYS_ACTION = "getAllDisplays" as const;

export class GetAllDisplaysRendererIpc extends AsyncRendererIpc<
	typeof GET_ALL_DISPLAYS_ACTION,
	GetAllDisplaysIpcParameters,
	GetAllDisplaysIpcReturn
> {
	action = GET_ALL_DISPLAYS_ACTION;
}
