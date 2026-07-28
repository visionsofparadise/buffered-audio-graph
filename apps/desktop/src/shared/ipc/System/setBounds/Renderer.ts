import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export interface BoundsRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export type SetBoundsIpcParameters = [bounds: BoundsRect];
export type SetBoundsIpcReturn = undefined;
export const SET_BOUNDS_ACTION = "setBounds" as const;

export class SetBoundsRendererIpc extends AsyncRendererIpc<
	typeof SET_BOUNDS_ACTION,
	SetBoundsIpcParameters,
	SetBoundsIpcReturn
> {
	action = SET_BOUNDS_ACTION;
}
