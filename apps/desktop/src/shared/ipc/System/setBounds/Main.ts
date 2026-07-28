import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { SET_BOUNDS_ACTION, type SetBoundsIpcParameters, type SetBoundsIpcReturn } from "./Renderer";
import type { BoundsRect } from "./Renderer";

export class SetBoundsMainIpc extends AsyncMainIpc<SetBoundsIpcParameters, SetBoundsIpcReturn> {
	action = SET_BOUNDS_ACTION;

	handler(bounds: BoundsRect, dependencies: IpcHandlerDependencies): SetBoundsIpcReturn {
		dependencies.browserWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
	}
}
